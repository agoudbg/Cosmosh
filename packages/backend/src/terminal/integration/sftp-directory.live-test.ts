import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SFTPWrapper } from 'ssh2';

import { createI18n } from '../../i18n-bridge.js';
import { escapeSftpShellPath, SftpSessionService } from '../../sftp/session-service.js';
import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { openFixtureTerminal } from './fixture-client.js';

test(
  'real SFTP preserves directory identity and rejects copies into aliased descendants',
  { timeout: 30_000 },
  async (t) => {
    const terminal = await openFixtureTerminal('bash');
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cosmosh-sftp-live-'));
    const service = new SftpSessionService({
      // Database/authentication and audit persistence are explicit external boundaries.
      // Filesystem resolution and copy operations use the real authenticated SFTP channel.
      getDbClient: () => ({}) as never,
      auditEventService: { logEvent: async () => null } as never,
      credentialEncryptionKey: Buffer.alloc(32),
      sftpTemporaryRootPath: tempRoot,
    });
    t.after(async () => {
      await service.closeAllSessions();
      terminal.close();
      await rm(tempRoot, { recursive: true, force: true });
    });
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      terminal.client.sftp((error, channel) => (error ? reject(error) : resolve(channel)));
    });
    const session = {
      sessionId: 'sftp-directory-fixture',
      serverId: 'loopback-fixture',
      client: terminal.client,
      sftp,
      isClosed: false,
      t: createI18n({ locale: 'en' }).t,
    };
    const internals = service as unknown as {
      sessions: Map<string, typeof session>;
      watchSessionTransport(value: typeof session): void;
    };
    internals.sessions.set(session.sessionId, session);
    internals.watchSessionTransport(session);
    const root = '/home/cosmosh-bash/sftp-' + randomUUID();
    const source = root + '/source';
    const link = root + '/link';
    const unusualName = ' space 中文\\name\n ';
    const unusualPath = source + '/' + unusualName;
    await executeBoundedSshCommand(
      terminal.client,
      'mkdir -p ' +
        escapeSftpShellPath(source + '/child') +
        ' ' +
        escapeSftpShellPath(unusualPath) +
        '; ln -s ' +
        escapeSftpShellPath(source + '/child') +
        ' ' +
        escapeSftpShellPath(link),
    );
    const listing = await service.listDirectory(session.sessionId, link + '/..');
    assert.equal(listing.type, 'success');
    if (listing.type !== 'success') return;
    assert.equal(listing.path, source, 'realpath must resolve the symbolic link before its parent component');
    assert.ok(listing.entries.some((entry) => entry.name === unusualName && entry.path === unusualPath));
    for (const [from, to] of [
      [root + '/./source', source + '/child/copy-dot'],
      [source + '/child/../../source', source + '/child/copy-parent'],
      [source, link + '/copy-link'],
    ]) {
      const result = await service.copyEntry(session.sessionId, from, to);
      assert.equal(result.type, 'failed');
      if (result.type === 'failed') assert.equal(result.message, session.t('errors.sftp.copyIntoSelfUnsupported'));
    }
    const childListing = await service.listDirectory(session.sessionId, source + '/child');
    assert.equal(childListing.type, 'success');
    if (childListing.type === 'success')
      assert.deepEqual(childListing.entries, [], 'rejected copies must not create partial trees');
    const copied = await service.copyEntry(session.sessionId, source, root + '/ordinary-copy');
    assert.equal(copied.type, 'success', 'a normal copy outside the source remains supported');
    const copiedListing = await service.listDirectory(session.sessionId, root + '/ordinary-copy');
    assert.equal(copiedListing.type, 'success');
    if (copiedListing.type === 'success') assert.ok(copiedListing.entries.some((entry) => entry.name === unusualName));
    const renamedPath = source + '/ renamed 中文\\name\n ';
    assert.equal((await service.renameEntry(session.sessionId, unusualPath, renamedPath)).type, 'success');
    const renamedListing = await service.listDirectory(session.sessionId, source);
    assert.equal(renamedListing.type, 'success');
    if (renamedListing.type === 'success')
      assert.ok(renamedListing.entries.some((entry) => entry.path === renamedPath));
  },
);
