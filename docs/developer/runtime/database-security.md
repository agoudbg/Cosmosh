# Database Security (Current Implementation)

This page explains how Cosmosh protects local database data today, why Linux may show `safeStorage` fallback errors, and what developers/operators should do to unblock startup safely.

## 1. Plain-English Mental Model

Think of Cosmosh database protection as a 2-step lock:

1. **Database key generation / recovery** (done in Electron Main process).
2. **Database encryption/decryption usage** (done in Backend process through `COSMOSH_DB_ENCRYPTION_KEY`).

Main process decides where the real key comes from:

- Preferred path: OS-backed key protection via Electron `safeStorage`.
- Fallback path: master-password-based key derivation (for environments where `safeStorage` is not available).

Backend does not invent a key in production. It expects the resolved key from Main via environment variable.

## 2. Scope and Threat Assumptions

### 2.1 What this model protects

- Reduces risk of plaintext database exposure at rest.
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
- DB location is workspace `.dev_data/cosmosh.db`.

This is intentionally convenience-oriented, not production security.

### 3.2 Production packaged mode (`app.isPackaged`)

Main process calls `getDatabaseEncryptionKey()` and then injects result into backend env:

- `COSMOSH_DB_ENCRYPTION_KEY=<resolved key>`
- Backend reads it in `packages/backend/src/db/prisma.ts`

If backend does not receive this key in production, it fails fast with `[db:key] Missing COSMOSH_DB_ENCRYPTION_KEY ...`.

### 3.3 Schema ownership and startup policy

- Database schema is owned by Prisma workflows (`prisma db push` in dev, migrations in packaged/prod pipelines).
- Backend startup validates required tables and fails fast if schema is missing, instead of creating tables via runtime hand-written SQL.
- In strict production mode, SQLCipher/Prisma unreadable-file errors are not auto-recovered by decrypting/resetting local files; startup fails with explicit diagnostics so operators can fix the root cause.

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

## 5. Fallback Path: Master Password Mode (When `safeStorage` Unavailable)

When `safeStorage.isEncryptionAvailable()` is `false`, Main logs:

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

- Verify hash: `sha256("<salt>:<password>")` compared with stored `masterPasswordHash`.
- Constant-time compare: `timingSafeEqual(...)`.
- If verified, derive DB key: `scryptSync(password, salt, 32).toString('hex')`.

If hash check fails, startup throws:

- `master password verification failed in fallback mode.`

### 5.4 Why this Linux error pattern appears

This error sequence usually indicates:

1. `safeStorage` unavailable on target Linux environment.
2. App entered fallback mode.
3. `security.config.json` lacked `masterPasswordHash` (and/or related fallback metadata).
4. No completed renderer flow to collect and persist master-password metadata yet.
5. Startup aborted by design to avoid using an unverified key.

The DBus/systemd line shown after that is usually side-effect noise from process lifecycle and does not change the root cause above.

## 6. `security.config.json` Current Schema

Path:

- Production: `<userData>/security.config.json`

Fields:

- `encryptedDbMasterKey?: string`
  - Base64 encoded encrypted payload from `safeStorage` path.
- `masterPasswordHash?: string`
  - Hex hash used only in fallback verification.
- `masterPasswordSalt?: string`
  - Salt string used for verification and scrypt key derivation.

Notes:

- File can contain both safeStorage and fallback fields during transitions.
- Fallback fields are required only when `safeStorage` is unavailable.

## 7. Action Playbook for Linux Packaging

Until renderer-side “Set Master Password” flow is implemented end-to-end, use controlled operational fallback.

### 7.1 Immediate unblock checklist

1. Choose a strong master password in secure operator workflow.
2. Generate/store `masterPasswordSalt`.
3. Compute `masterPasswordHash = sha256("<salt>:<password>")` in hex.
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

## 10. Related Source Files

- `packages/main/src/security/database-encryption.ts`
- `packages/main/src/index.ts`
- `packages/backend/src/db/prisma.ts`
- `docs/developer/core/architecture.md`
