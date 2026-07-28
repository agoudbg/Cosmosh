# Database Security (Current Implementation)

This page explains how Cosmosh protects local database data today, why Linux may show `safeStorage` fallback errors, and what developers/operators should do to unblock startup safely.

## 1. Plain-English Mental Model

Think of Cosmosh database protection as a 2-step lock:

1. **Database key generation / recovery** (done in Electron Main process).
2. **Database page encryption/decryption** (done in Backend through a Prisma driver adapter backed by the SQLCipher native binding).

Main process decides where the real key comes from:

- Preferred path: OS-backed key protection via Electron `safeStorage`.
- Fallback path: master-password-based key derivation (for environments where `safeStorage` is not available).

Backend does not invent a key in production. It expects the resolved key from Main via environment variable.

## 2. Scope and Threat Assumptions

### 2.1 What this model protects

- Encrypts production database pages at rest instead of only protecting the database key.
- Avoids directly storing raw database encryption keys in plain config in production mode.
- Keeps key bootstrap logic in Main process instead of Renderer.

### 2.2 What this model does not protect

- A fully compromised user session where attacker can read process memory.
- Unsafe operational handling (for example leaking fallback environment variables into logs or shell history).
- Cases where fallback metadata is missing and no user-facing master-password setup flow is available yet.

## 3. Runtime Modes and Key Sources

### 3.1 Development mode (`!app.isPackaged`)

- Main returns constant key `cosmosh_dev_key`.
- Backend also uses deterministic dev key behavior.
- Default DB location is workspace `.dev_data/cosmosh.db`.
- When a development profile is active through `pnpm dev:profile` or `COSMOSH_DEV_PROFILE`, DB location becomes `.cosmosh/dev-profiles/<name>/database/cosmosh.db`, and Electron `userData` plus backend secret storage are isolated under the same profile root.

This is intentionally convenience-oriented, not production security.

### 3.2 Production packaged mode (`app.isPackaged`)

Main process calls `getDatabaseEncryptionKey()` and then injects result into backend env:

- `COSMOSH_DB_ENCRYPTION_KEY=<resolved key>`
- Backend reads it in `packages/backend/src/db/prisma.ts`

If backend does not receive this key in production, it fails fast with `[db:key] Missing COSMOSH_DB_ENCRYPTION_KEY ...`.

### 3.3 Schema ownership and startup policy

- Database schema is owned by Prisma workflows (`prisma db push` in dev, migrations in packaged/prod pipelines).
- Backend startup validates required tables and fails fast if schema is missing, instead of creating tables via runtime hand-written SQL.
- Production Prisma clients use `PrismaSqlCipherAdapterFactory` from `packages/backend/src/db/sqlcipher.ts`. It composes Prisma's `@prisma/adapter-better-sqlite3` query/transaction contract with the native binding from `better-sqlite3-multiple-ciphers`.
- The adapter applies `cipher` and `key` before returning the connection to Prisma, then reads `sqlite_master` through that same keyed connection. SQLCipher is therefore the actual Prisma storage path, not a separate preflight connection.
- First-run migrations execute through the keyed adapter. After schema convergence, Backend rejects an empty file or a file exposing the plaintext `SQLite format 3\0` header.
- The SQLCipher native driver is mandatory in production. Missing/incompatible bindings or incorrect keys fail startup; there is no production plaintext Prisma fallback.

### 3.4 One-time legacy plaintext migration

Production startup recognizes only the canonical plaintext SQLite header as eligible for automatic migration. Unknown, corrupt, or encrypted files with an incorrect key are never treated as plaintext.

Migration sequence:

1. Checkpoint the plaintext WAL and switch the source to `journal_mode=DELETE`.
2. Copy the checkpointed source to `<database>.sqlcipher-migration`.
3. Apply SQLCipher `rekey` only to the copy.
4. Verify the encrypted copy with the resolved key, `integrity_check`, and source/destination schema table counts.
5. Rename the source to `<database>.plaintext-backup`, promote the verified encrypted copy, and verify the promoted database again.
6. Delete the temporary plaintext backup after successful promotion.

The fixed temporary/backup names make both rename interruption windows recoverable on the next startup. Before the encrypted copy verifies, the original plaintext database remains authoritative. If an interrupted encrypted temp cannot be verified, recovery preserves both artifacts and fails fast because it cannot safely distinguish corruption from an incorrect key; retrying with the original key can still promote the verified temp. Migration failures use `DB_SQLCIPHER_MIGRATION_FAILED`; SQLCipher/key/bootstrap failures use `DB_SQLCIPHER_BOOTSTRAP_FAILED`.

## 4. Preferred Path: Electron `safeStorage`

When `safeStorage.isEncryptionAvailable()` is `true`:

1. Main reads `security.config.json` under `app.getPath('userData')`.
2. If `encryptedDbMasterKey` exists:
   - Base64 decode → `safeStorage.decryptString(...)`.
   - Use decrypted plaintext as database key.
3. If it does not exist:
   - Generate random 32-byte key (`randomBytes(32).toString('hex')`).
   - Encrypt with `safeStorage.encryptString(...)`.
   - Store encrypted payload as `encryptedDbMasterKey` in `security.config.json`.

Important behavior:

- Stored value is encrypted blob, not plaintext key.
- Decryption is bound to OS secure storage availability.
- Main process performs encryption/decryption; renderer is not used for this path.
- If decryption succeeds and a plaintext emergency fallback field is present from an older or broken write path, Main removes that plaintext field as best-effort cleanup.
- If decryption or secure persistence fails at runtime, Main attempts fallback resolver instead of writing a plaintext emergency key while `safeStorage` is available.

## 5. Fallback Path: Master Password Mode (When `safeStorage` Is Unavailable or Fails)

Main enters fallback resolver in all of these cases:

1. `safeStorage.isEncryptionAvailable()` is `false`.
2. `safeStorage` is available but `encryptedDbMasterKey` decryption fails.
3. `safeStorage` is available but encrypt/persist fails while creating a new key.
4. `safeStorage` path is unavailable and emergency fallback key is available.

When fallback is entered due to unavailable `safeStorage`, Main logs:

- `[db:key] Electron safeStorage is unavailable. Falling back to master password mode.`

Then it enters fallback resolver.

### 5.1 Required fallback metadata

`security.config.json` must contain:

- `masterPasswordHash`
- `masterPasswordSalt`

If `masterPasswordHash` is missing, startup throws:

- `secure storage unavailable and no master_password_hash found in config ...`

### 5.2 Required fallback secret input

Environment variable required:

- `COSMOSH_DB_MASTER_PASSWORD`

If password env or salt is missing, startup throws:

- `secure storage unavailable. Missing COSMOSH_DB_MASTER_PASSWORD or masterPasswordSalt ...`

### 5.3 Verification + key derivation details

Fallback verification and derivation are currently:

- Root secret: `scryptSync(password, salt, 32)`.
- Verify hash: `hkdfSync('sha256', rootSecret, salt, 'cosmosh/master-password/verifier/v1', 32)` (hex) compared with stored `masterPasswordHash`.
- Constant-time compare: `timingSafeEqual(...)`.
- If verified, derive DB key: `hkdfSync('sha256', rootSecret, salt, 'cosmosh/master-password/database-key/v1', 32)` (hex).

The two HKDF `info` contexts are intentionally different (domain separation): the persisted verification hash never equals the database encryption key, so reading `security.config.json` alone cannot decrypt the database.

If hash check fails, startup throws:

- `master password verification failed in fallback mode.`

### 5.4 Emergency fallback key path

To avoid startup dead-end only when `safeStorage` is unavailable, Main may persist an emergency local fallback key:

- `emergencyFallbackDbMasterKey?: string`

Runtime behavior:

1. If `safeStorage` is unavailable and an emergency fallback key exists, use it directly.
2. If `safeStorage` is unavailable and master-password fallback succeeds, persist emergency fallback key for future non-interactive recovery.
3. If `safeStorage` is unavailable, no DB file exists, and fallback resolver fails, auto-provision a new emergency fallback key for first-run startup.
4. If `safeStorage` is available, newly generated or recovered keys are persisted only as `encryptedDbMasterKey`. Main does not newly write a plaintext emergency fallback key in this mode.

If an existing DB file already exists and neither `safeStorage` nor fallback materials can recover old key material, startup still fails fast with explicit error to avoid silent data lockout.

### 5.5 Auto-migration when `safeStorage` recovers

If fallback successfully resolves a key while `safeStorage` is available again, Main will automatically:

1. Encrypt the resolved fallback key with `safeStorage`.
2. Persist it into `security.config.json` as `encryptedDbMasterKey`.
3. Remove `emergencyFallbackDbMasterKey` from the config.
4. Continue startup using the same recovered key.

This avoids accidental key rotation and keeps previously encrypted database data readable after recovery.

### 5.6 Why this Linux error pattern appears

This error sequence usually indicates:

1. `safeStorage` unavailable on target Linux environment.
2. App entered fallback mode.
3. `security.config.json` lacked `masterPasswordHash` (and/or related fallback metadata).
4. No completed renderer flow to collect and persist master-password metadata yet.
5. Startup aborted by design to avoid using an unverified key.

The DBus/systemd line shown after that is usually side-effect noise from process lifecycle and does not change the root cause above.

## 5.7 Development Profile Isolation

Development profiles are intentionally convenience-oriented and always use the deterministic development key `cosmosh_dev_key`. They are for local verification of onboarding, first-run storage, settings defaults, and database bootstrap behavior.

Profile state lives under `.cosmosh/dev-profiles/` and is ignored by Git:

- `.cosmosh/dev-profiles/state.json`: current profile pointer written by `pnpm dev:profile use <name>`.
- `.cosmosh/dev-profiles/<name>/user-data`: Electron `userData` override.
- `.cosmosh/dev-profiles/<name>/database/cosmosh.db`: SQLite database file injected through `COSMOSH_DB_PATH`.
- `.cosmosh/dev-profiles/<name>/backend-storage`: backend secret storage injected through `COSMOSH_BACKEND_STORAGE_PATH`.
- `.cosmosh/dev-profiles/default/profile.json`: manifest for the automatic legacy default import.

The first non-help `pnpm dev:profile` command imports the implicit legacy default identity into the managed `default` profile. The importer copies `.dev_data/cosmosh.db` plus SQLite `-wal` and `-shm` files when readable, copies the legacy Electron `userData` directory, and copies backend secret storage. Copy results are best-effort and are recorded in `profile.json`, so an unreadable legacy source creates an `import=partial` profile instead of deleting or mutating the original source.

Deleting or resetting a regular profile only affects that profile directory. The managed `default` profile rejects regular reset/delete commands; use `pnpm dev:profile import-default --force` to rebuild it from legacy sources. None of these commands touch the legacy development DB at `.dev_data/cosmosh.db` unless that file is manually removed outside the profile tool.

## 6. `security.config.json` Current Schema

Path:

- Production: `<userData>/security.config.json`

Fields:

- `encryptedDbMasterKey?: string`
  - Base64 encoded encrypted payload from `safeStorage` path.
- `emergencyFallbackDbMasterKey?: string`
  - Plaintext emergency fallback key used only for availability-first recovery while `safeStorage` is unavailable.
- `masterPasswordHash?: string`
  - Hex hash used only in fallback verification.
- `masterPasswordSalt?: string`
  - Salt string used for verification and scrypt key derivation.

Notes:

- File can temporarily contain both safeStorage and fallback fields during recovery, but the `safeStorage` path removes plaintext emergency material after secure key resolution succeeds.
- Fallback fields are required only when `safeStorage` is unavailable.
- Emergency fallback key can be used to repopulate `encryptedDbMasterKey` after `safeStorage` becomes available again, then it is removed.

## 6.1 Prisma and SQLCipher Runtime Packaging

Packaged production runtime must include all parts of the single encrypted connection path:

- `@prisma/adapter-better-sqlite3` and `@prisma/driver-adapter-utils` at the same version as `@prisma/client`.
- The `better-sqlite3` JavaScript wrapper required by Prisma's adapter.
- The filtered `better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node` native binding.

`packages/main/scripts/sync-backend-runtime.cjs` recursively copies the adapter dependencies and separately preserves only the required SQLCipher native binding from the multi-cipher package.

The native binding has two explicit build targets. Development Main and standalone Backend commands run Backend under the workspace system Node, so their startup lifecycles probe that runtime and rebuild only after an ABI mismatch. Packaging always rebuilds for the exact installed Electron version before runtime synchronization. Every successful rebuild must pass an in-memory database open/close probe under its target runtime; file existence alone is not accepted as compatibility evidence. On Windows, stop processes using the current binding before switching targets because the loaded native file is locked.

Prisma Client, Prisma CLI, both adapter packages, and `better-sqlite3-multiple-ciphers` are pinned as one tested compatibility tuple. Upgrade them deliberately and rerun the encrypted reconnect, incorrect-key, plaintext-migration, and packaged-runtime tests on every supported platform before changing that tuple.

To avoid backend startup failures such as `Prisma Client could not locate the Query Engine` on target machines, Linux packaging must include these Prisma Linux targets:

- `debian-openssl-1.1.x`
- `debian-openssl-3.0.x`

CI validates required `libquery_engine-*.so.node` files via `COSMOSH_REQUIRED_PRISMA_TARGETS` during prebuild and fails fast when any required target is missing.

Runtime asset sync is platform-aware:

- Linux packages keep Linux `*.so.node` Prisma engines.
- Windows packages keep Windows `*.dll.node` Prisma engines.
- macOS packages keep Darwin `*.dylib.node` Prisma engines.

This prevents Linux compatibility binaries from being copied into Windows/macOS artifacts while preserving Linux fallback coverage.

## 7. Action Playbook for Linux Packaging

Until renderer-side “Set Master Password” flow is implemented end-to-end, use controlled operational fallback.

### 7.1 Immediate unblock checklist

1. Choose a strong master password in secure operator workflow.
2. Generate/store `masterPasswordSalt`.
3. Compute `masterPasswordHash` with the same formula as runtime: `rootSecret = scryptSync(password, salt, 32)`, then `hkdfSync('sha256', rootSecret, salt, 'cosmosh/master-password/verifier/v1', 32)` encoded as hex.
4. Write both fields into `<userData>/security.config.json`.
5. Set env `COSMOSH_DB_MASTER_PASSWORD` before launching app.
6. Ensure env is not exposed in shell history/system logs where avoidable.

If any of the above is missing or mismatched, startup fails intentionally.

### 7.2 Operational cautions

- Do not commit fallback password, salt, or derived values to source control.
- Do not print fallback secret values in debug logs.
- Prefer one-time secret injection mechanisms over persistent plaintext env files.

## 8. Current Gaps and Planned Direction

Current gap:

- Error messages mention renderer IPC for “Set Master Password”, but renderer flow is not yet fully wired for production bootstrap in `safeStorage`-unavailable environments.

Planned direction (implementation target, not yet complete):

- Add secure renderer-initiated master-password setup flow.
- Persist fallback metadata (`masterPasswordHash`, `masterPasswordSalt`) through controlled IPC path.
- Improve first-run UX when Linux secure storage is unavailable.

## 9. Troubleshooting Matrix

In desktop runtime, developers can inspect these diagnostics directly in Settings → Advanced → Database Encryption Info.

### Symptom: `safeStorage is unavailable`

- Meaning: OS secure storage integration is not available in current runtime.
- Next step: verify fallback metadata + `COSMOSH_DB_MASTER_PASSWORD`.

### Symptom: `no master_password_hash found in config`

- Meaning: fallback verification metadata not provisioned.
- Next step: pre-provision `masterPasswordHash` and `masterPasswordSalt`.

### Symptom: `verification failed in fallback mode`

- Meaning: provided password does not match hash/salt pair.
- Next step: verify password source, hash generation formula, and target config file path.

### Symptom: backend says missing `COSMOSH_DB_ENCRYPTION_KEY`

- Meaning: main process did not successfully resolve key.
- Next step: inspect main-process earlier logs for safeStorage/fallback failure reason.

### Symptom: `DB_SQLCIPHER_MIGRATION_FAILED`

- Meaning: a recognized plaintext SQLite database could not be checkpointed, encrypted, verified, or atomically promoted.
- Next step: preserve the primary database plus `.sqlcipher-migration` / `.plaintext-backup` artifacts and inspect the nested cause before retrying.

### Symptom: `file is not a database` after SQLCipher key application

- Meaning: the file is encrypted with another key, corrupt, or not a recognized plaintext SQLite database.
- Next step: verify `security.config.json` and OS secure-storage identity. Do not delete or regenerate key material automatically.

## 10. Related Source Files

- `packages/main/src/security/database-encryption.ts`
- `packages/main/src/index.ts`
- `packages/backend/src/db/prisma.ts`
- `packages/backend/src/db/sqlcipher.ts`
- `packages/backend/src/db/sqlcipher.test.ts`
- `docs/developer/core/architecture.md`
