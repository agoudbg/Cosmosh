import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PrismaClient } from '@prisma/client';

import { createI18n } from '../../i18n-bridge.js';
import { openSshClient, type SshServerWithKeychain } from '../../ssh/connect.js';
import { encryptSensitiveValue } from '../../ssh/crypto.js';
import { createCredentialFillState } from '../credential-fill.js';
import { createCredentialServiceHarness } from './credential-harness.js';
import { openFixtureTerminal, readFixtureConnection } from './fixture-client.js';

test(
  'real SSH password fill preserves literal input and waits for the user to press Enter',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    const disconnected = new Promise<void>((resolve) => terminal.client.once('close', resolve));
    t.after(async () => {
      try {
        terminal.close();
      } finally {
        terminal.client.destroy();
      }
      await disconnected;
    });
    const ready = terminal.write("printf 'CREDENTIAL_READY:%s\\n' 'ok'\r");
    await terminal.waitFor(/CREDENTIAL_READY:ok\r?\n/u, ready);
    const password = 'fixture 口令🔑 $\\"';
    const harness = createCredentialServiceHarness({ password, stream: terminal.channel });
    harness.session.credentialFillState = createCredentialFillState();
    terminal.onOutput((data) => harness.service.handleShellOutput(harness.session, data));
    const prompt = terminal.write(
      "IFS= read -r -s -p 'Password: ' fixture_password; printf '\\nFILLED:%s\\n' \"$fixture_password\"; unset fixture_password\r",
    );
    await terminal.waitFor(/Password: $/u, prompt);
    const offer = harness.session.credentialFillState.offer;
    assert.ok(offer);
    await harness.service.fillLoginPassword(harness.session, offer.token);
    assert.ok(!JSON.stringify(harness.sent).includes(password));
    // A real blocked read proves that the action did not submit the password.
    await assert.rejects(terminal.waitFor(/\r?\nFILLED:/u, prompt, 250), /did not match/u);
    const submitted = terminal.write('\r');
    const result = await terminal.waitFor(/\r?\nFILLED:([^\r\n]*)\r?\n/u, submitted);
    assert.equal(result[1], password);
  },
);

test(
  'real encrypted-key authentication never exposes its passphrase as a login password',
  { timeout: 30_000 },
  async (t) => {
    const connection = readFixtureConnection();
    const directory = mkdtempSync(path.join(tmpdir(), 'cosmosh-credential-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const keyPath = path.join(directory, 'fixture-key');
    writeFileSync(keyPath, connection.privateKey, { mode: 0o600 });
    if (process.platform === 'win32') {
      // Restrict only this test-owned file: OpenSSH rejects inherited Windows temp ACLs.
      execFileSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${userInfo().username}:(F)`], {
        timeout: 10_000,
        windowsHide: true,
        stdio: 'pipe',
      });
    }
    const passphrase = 'fixture-key-passphrase-only';
    execFileSync('ssh-keygen', ['-p', '-q', '-P', '', '-N', passphrase, '-f', keyPath], {
      timeout: 10_000,
      windowsHide: true,
      stdio: 'pipe',
    });
    const encryptionKey = randomBytes(32);
    const now = new Date();
    const server: SshServerWithKeychain = {
      id: 'fixture-server',
      name: 'fixture',
      iconKey: 'Server',
      colorKey: 'blue',
      host: connection.host,
      port: connection.port,
      username: 'cosmosh-bash',
      strictHostKey: true,
      enableSshCompression: false,
      remoteEnhancementsEnabled: false,
      disableCharacterWidthCompatibilityMode: false,
      terminalClipboardAccess: 'off',
      proxyMode: 'off',
      proxyUrl: null,
      keychainId: 'fixture-keychain',
      note: null,
      folderId: null,
      systemHostname: null,
      systemOs: null,
      systemArch: null,
      systemKernel: null,
      lastSystemSyncAt: null,
      createdAt: now,
      updatedAt: now,
      keychain: {
        id: 'fixture-keychain',
        name: 'fixture',
        iconKey: 'KeyRound',
        colorKey: 'emerald',
        authType: 'key',
        passwordEncrypted: null,
        privateKeyEncrypted: encryptSensitiveValue(readFileSync(keyPath, 'utf8'), encryptionKey),
        privateKeyPassphraseEncrypted: encryptSensitiveValue(passphrase, encryptionKey),
        visibility: 'hidden',
        note: null,
        folderId: null,
        createdAt: now,
        updatedAt: now,
      },
    };
    const result = await openSshClient(server, {
      connectTimeoutSec: 10,
      // Explicitly disabled proxy policy requires no database access.
      db: {} as PrismaClient,
      strictHostKey: true,
      trustedFingerprintSet: new Set([connection.hostFingerprint]),
      credentialEncryptionKey: encryptionKey,
      t: createI18n({ locale: 'en' }).t,
    });
    assert.equal(result.type, 'ready');
    if (result.type !== 'ready') return;
    t.after(() => {
      result.lifecycleMonitor.releaseAfterClose();
      result.client.destroy();
    });
    assert.equal(result.loginPassword, null);
  },
);
