import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test, { after } from 'node:test';

import { API_CODES, type ApiSftpTaskData } from '@cosmosh/api-contract';

import { SftpArchiveError } from './archive-service.js';
import { SFTP_OPERATION_TIMEOUT_CODE, SFTP_TRANSPORT_CLOSED_CODE } from './operation-guard.js';
import {
  escapeSftpShellPath,
  formatSftpPermissionOctal,
  formatSftpPermissions,
  isMutableSftpEntryPath,
  joinSftpPath,
  normalizeSftpPathInput,
  resolveSftpEntryHiddenState,
  resolveSftpEntryType,
  SftpSessionService,
} from './session-service.js';

type TestSftpClient = EventEmitter & {
  destroy(): void;
  end(): void;
};

type TestSftpSession = {
  sessionId: string;
  serverId: string;
  client: TestSftpClient;
  sftp: EventEmitter;
  isClosed: boolean;
  t: (key: string) => string;
};

type TestSftpStats = {
  mode: number;
  size: number;
  mtime: number;
  atime: number;
  uid: number;
  gid: number;
  isFile(): boolean;
  isDirectory(): boolean;
};

type TestSftpDirectoryEntry = {
  filename: string;
  longname?: string;
  attrs: TestSftpStats;
};

type TestListSftp = EventEmitter & {
  realpath(targetPath: string, callback: (error: Error | null, resolvedPath: string) => void): void;
  readdir(targetPath: string, callback: (error: Error | null, entries?: TestSftpDirectoryEntry[]) => void): void;
  readlink(targetPath: string, callback: (error: Error | null, linkString: string) => void): void;
  stat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
};

type TestUploadSftp = EventEmitter & {
  stat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
  createWriteStream(targetPath: string, options: { flags: string; mode: number }): Writable;
  rename(sourcePath: string, targetPath: string, callback: (error?: Error | null) => void): void;
  unlink(targetPath: string, callback: (error?: Error | null) => void): void;
  ext_openssh_rename?(sourcePath: string, targetPath: string, callback: (error?: Error | null) => void): void;
};

type TestDownloadSftp = EventEmitter & {
  destroy?(): void;
  stat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
  createReadStream(targetPath: string, options: { flags: string }): Readable;
};

type TestLinkSftp = EventEmitter & {
  stat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
  symlink(targetPath: string, linkPath: string, callback: (error?: Error | null) => void): void;
};

type TestRenameSftp = EventEmitter & {
  lstat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
  rename(sourcePath: string, targetPath: string, callback: (error?: Error | null) => void): void;
};

type TestDeleteSftp = EventEmitter & {
  destroy(): void;
  lstat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
  unlink(targetPath: string, callback: (error?: Error | null) => void): void;
};

type TestSftpSessionServiceInternals = {
  sessions: Map<string, TestSftpSession>;
  taskSchedulers: Map<
    string,
    {
      listTasks(): unknown[];
    }
  >;
  watchSessionTransport(session: TestSftpSession): void;
};

const TEST_SFTP_TEMP_ROOT_PATH = mkdtempSync(path.join(os.tmpdir(), 'cosmosh-sftp-test-root-'));

if (process.platform !== 'win32') {
  chmodSync(TEST_SFTP_TEMP_ROOT_PATH, 0o700);
}

after(async () => {
  await fs.rm(TEST_SFTP_TEMP_ROOT_PATH, { force: true, recursive: true });
});

/**
 * Creates a session service with optional short operation deadlines for deterministic lifecycle tests.
 *
 * @param sftpOperationIdleTimeoutMs Optional idle deadline override.
 * @returns Isolated SFTP session service.
 */
const createTestSftpSessionService = (sftpOperationIdleTimeoutMs?: number): SftpSessionService => {
  return new SftpSessionService({
    getDbClient: () => ({}) as never,
    auditEventService: { logEvent: async () => null } as never,
    credentialEncryptionKey: Buffer.alloc(32),
    sftpTemporaryRootPath: TEST_SFTP_TEMP_ROOT_PATH,
    ...(sftpOperationIdleTimeoutMs !== undefined ? { sftpOperationIdleTimeoutMs } : {}),
  });
};

const createTestSftpSession = (): TestSftpSession => {
  const client = new EventEmitter() as TestSftpClient;
  const sftp = new EventEmitter() as EventEmitter & { destroy(): void };
  client.destroy = (): void => undefined;
  client.end = (): void => undefined;
  sftp.destroy = (): void => undefined;

  return {
    sessionId: 'test-session',
    serverId: 'test-server',
    client,
    sftp,
    isClosed: false,
    t: (key) => key,
  };
};

const getTestInternals = (service: SftpSessionService): TestSftpSessionServiceInternals => {
  return service as unknown as TestSftpSessionServiceInternals;
};

const registerTestSession = (service: SftpSessionService, session: TestSftpSession): void => {
  const internals = getTestInternals(service);
  internals.sessions.set(session.sessionId, session);
  internals.watchSessionTransport(session);
};

/**
 * Waits for one asynchronous task to reach a terminal state in focused service tests.
 *
 * @param service Session service under test.
 * @param sessionId Owning session id.
 * @param taskId Accepted task id.
 * @returns Terminal task snapshot.
 */
const waitForTerminalTask = async (
  service: SftpSessionService,
  sessionId: string,
  taskId: string,
): Promise<ApiSftpTaskData> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = service.getTask(sessionId, taskId);
    if (task && task.state !== 'queued' && task.state !== 'running') {
      return task;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(`Task did not reach a terminal state: ${taskId}`);
};

test('active session count tracks bulk SFTP session close operations', async () => {
  const service = createTestSftpSessionService();
  const firstSession = createTestSftpSession();
  const secondSession = createTestSftpSession();
  firstSession.sessionId = 'sftp-count-1';
  secondSession.sessionId = 'sftp-count-2';

  registerTestSession(service, firstSession);
  registerTestSession(service, secondSession);

  assert.equal(service.getActiveSessionCount(), 2);
  assert.equal(await service.closeAllSessions(), 2);
  assert.equal(service.getActiveSessionCount(), 0);
  assert.equal(firstSession.isClosed, true);
  assert.equal(secondSession.isClosed, true);
  assert.equal(await service.closeAllSessions(), 0);

  await service.stop();
});

test('legacy write reserves its path, rejects queued archive admission, and forgets hidden tasks', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const pendingStats: Array<(error: Error | null, stats?: TestSftpStats) => void> = [];
  const statPaths: string[] = [];
  const sftp = new EventEmitter() as EventEmitter & {
    destroy(): void;
    stat(targetPath: string, callback: (error: Error | null, stats?: TestSftpStats) => void): void;
  };
  sftp.destroy = (): void => undefined;
  sftp.stat = (targetPath, callback): void => {
    statPaths.push(targetPath);
    pendingStats.push(callback);
  };
  session.sftp = sftp;
  registerTestSession(service, session);

  const targetPath = '/srv/shared.txt';
  const write = service.writeTextFile(
    session.sessionId,
    targetPath,
    'updated',
    {
      size: 7,
      modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
    },
    {},
  );
  for (let attempt = 0; attempt < 100 && pendingStats.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(statPaths, [targetPath]);

  const read = service.readFilePreview(session.sessionId, targetPath);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(statPaths, [targetPath]);
  await assert.rejects(
    service.getArchiveCapabilities(session.sessionId),
    (error: unknown) => error instanceof SftpArchiveError && error.code === API_CODES.sftpArchiveBusy,
  );
  await assert.rejects(
    service.startArchiveOperation(session.sessionId, {
      type: 'compress',
      sourcePaths: [targetPath],
      targetDirectoryPath: '/srv',
      archiveName: 'shared.tar',
      format: 'tar',
      compressionLevel: 'store',
    }),
    (error: unknown) => error instanceof SftpArchiveError && error.code === API_CODES.sftpArchiveBusy,
  );

  pendingStats.shift()?.(null, createTestSftpStats({ entryType: 'directory', mtime: 1_710_000_000, size: 0 }));
  assert.equal((await write).type, 'failed');
  for (let attempt = 0; attempt < 100 && pendingStats.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(statPaths, [targetPath, targetPath]);

  pendingStats.shift()?.(null, createTestSftpStats({ entryType: 'directory', mtime: 1_710_000_000, size: 0 }));
  assert.equal((await read).type, 'failed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(getTestInternals(service).taskSchedulers.get(session.sessionId)?.listTasks(), []);

  await service.closeSession(session.sessionId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(getTestInternals(service).taskSchedulers.has(session.sessionId), false);

  await service.stop();
});

test('SftpSessionService retains a successful asynchronous rename task', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const renameSftp = createRenameSftpMock({
    '/srv/old.txt': createTestSftpStats({ size: 12, mtime: 1_710_000_000 }),
  });
  session.sftp = renameSftp.sftp;
  registerTestSession(service, session);

  const accepted = service.startTask(session.sessionId, {
    operation: 'rename',
    payload: {
      sourcePath: '/srv/old.txt',
      targetPath: '/srv/new.txt',
    },
  });

  assert.equal(accepted.type, 'success');
  if (accepted.type !== 'success') {
    return;
  }

  const terminal = await waitForTerminalTask(service, session.sessionId, accepted.task.taskId);
  assert.equal(terminal.state, 'succeeded');
  assert.deepEqual(terminal.remotePaths, ['/srv/new.txt', '/srv/old.txt']);
  assert.deepEqual(terminal.result, {
    type: 'operation',
    data: {
      sessionId: session.sessionId,
      path: '/srv/old.txt',
      targetPath: '/srv/new.txt',
    },
  });
  assert.deepEqual(renameSftp.renames, [{ sourcePath: '/srv/old.txt', targetPath: '/srv/new.txt' }]);
  assert.deepEqual(service.listTasks(session.sessionId), [terminal]);

  await service.stop();
});

test('SftpSessionService retains transport failure metadata after session eviction and ignores a late mutation callback', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const pendingRenameCallbacks: Array<(error?: Error | null) => void> = [];
  const renameSftp = new EventEmitter() as TestRenameSftp & { destroy(): void };
  renameSftp.destroy = (): void => undefined;
  renameSftp.lstat = (_targetPath, callback): void => {
    callback(null, createTestSftpStats({ size: 12, mtime: 1_710_000_000 }));
  };
  renameSftp.rename = (_sourcePath, _targetPath, callback): void => {
    pendingRenameCallbacks.push(callback);
  };
  session.sftp = renameSftp;
  registerTestSession(service, session);

  const accepted = service.startTask(session.sessionId, {
    operation: 'rename',
    payload: {
      sourcePath: '/srv/old.txt',
      targetPath: '/srv/new.txt',
    },
  });
  assert.equal(accepted.type, 'success');
  if (accepted.type !== 'success') {
    return;
  }

  for (let attempt = 0; attempt < 100 && pendingRenameCallbacks.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(pendingRenameCallbacks.length, 1);

  session.client.emit('close');
  const terminal = await waitForTerminalTask(service, session.sessionId, accepted.task.taskId);
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.errorCode, API_CODES.sftpTransportClosed);
  assert.equal(terminal.outcomeUnknown, true);
  assert.equal(service.getActiveSessionCount(), 0);

  pendingRenameCallbacks[0]?.(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(service.getTask(session.sessionId, accepted.task.taskId), terminal);

  await service.stop();
});

/**
 * Creates minimal ssh2-compatible stats for upload tests.
 *
 * @param options Stats options.
 * @returns Fake SFTP stats object.
 */
const createTestSftpStats = (options: {
  size: number;
  mtime: number;
  isFile?: boolean;
  entryType?: 'directory' | 'file' | 'symlink';
}): TestSftpStats => {
  const entryType = options.entryType ?? (options.isFile === false ? 'directory' : 'file');
  const mode = entryType === 'directory' ? 0o040755 : entryType === 'symlink' ? 0o120777 : 0o100644;

  return {
    mode,
    size: options.size,
    mtime: options.mtime,
    atime: options.mtime,
    uid: 1000,
    gid: 1000,
    isFile: () => entryType === 'file',
    isDirectory: () => entryType === 'directory',
  };
};

/**
 * Creates an SFTP stream mock for directory listing and symlink target metadata tests.
 *
 * @param entriesByDirectory Directory entries keyed by remote directory path.
 * @param linkTargetsByPath Raw readlink targets keyed by link path.
 * @param targetStatsByPath Target stat results keyed by resolved target path.
 * @returns Mock SFTP wrapper.
 */
const createListSftpMock = (
  entriesByDirectory: Record<string, TestSftpDirectoryEntry[]>,
  linkTargetsByPath: Record<string, string> = {},
  targetStatsByPath: Record<string, TestSftpStats> = {},
): TestListSftp => {
  const sftp = new EventEmitter() as TestListSftp;

  sftp.realpath = (targetPath, callback): void => {
    callback(null, targetPath);
  };
  sftp.readdir = (targetPath, callback): void => {
    callback(null, entriesByDirectory[targetPath] ?? []);
  };
  sftp.readlink = (targetPath, callback): void => {
    const linkTarget = linkTargetsByPath[targetPath];
    if (!linkTarget) {
      const error = new Error('No such file') as Error & { code: number };
      error.code = 2;
      callback(error, '');
      return;
    }

    callback(null, linkTarget);
  };
  sftp.stat = (targetPath, callback): void => {
    const stats = targetStatsByPath[targetPath];
    if (!stats) {
      const error = new Error('No such file') as Error & { code: number };
      error.code = 2;
      callback(error);
      return;
    }

    callback(null, stats);
  };

  return sftp;
};

/**
 * Creates an SFTP stream mock that serves one remote regular file.
 *
 * @param remotePath Remote source path.
 * @param content Binary file contents.
 * @returns Mock SFTP wrapper.
 */
const createDownloadSftpMock = (remotePath: string, content: Buffer): TestDownloadSftp => {
  const sftp = new EventEmitter() as TestDownloadSftp;
  sftp.destroy = (): void => undefined;
  sftp.stat = (targetPath, callback): void => {
    if (targetPath !== remotePath) {
      const error = new Error('No such file') as Error & { code: number };
      error.code = 2;
      callback(error);
      return;
    }

    callback(null, createTestSftpStats({ size: content.byteLength, mtime: 1_710_000_000 }));
  };
  sftp.createReadStream = (targetPath): Readable => {
    assert.equal(targetPath, remotePath);
    const splitAt = Math.floor(content.byteLength / 2);
    return Readable.from([content.subarray(0, splitAt), content.subarray(splitAt)]);
  };
  return sftp;
};

/**
 * Creates an SFTP stream mock that records upload replacement behavior.
 *
 * @param statsByPath Initial remote stats keyed by path.
 * @returns Mock SFTP wrapper and operation log.
 */
const createUploadSftpMock = (
  statsByPath: Record<string, TestSftpStats>,
  options: {
    posixRenameError?: Error;
    renameError?: Error;
    renameErrorCount?: number;
    unlinkError?: Error;
    withPosixRename?: boolean;
  } = {},
): {
  posixRenames: Array<{ sourcePath: string; targetPath: string }>;
  sftp: TestUploadSftp;
  unlinks: string[];
  writes: string[];
  writtenContentByPath: Map<string, string>;
  renames: Array<{ sourcePath: string; targetPath: string }>;
} => {
  const writes: string[] = [];
  const unlinks: string[] = [];
  const writtenContentByPath = new Map<string, string>();
  const renames: Array<{ sourcePath: string; targetPath: string }> = [];
  const posixRenames: Array<{ sourcePath: string; targetPath: string }> = [];
  const sftp = new EventEmitter() as TestUploadSftp;
  let renameErrorCount = options.renameErrorCount ?? (options.renameError ? Number.POSITIVE_INFINITY : 0);

  sftp.stat = (targetPath, callback): void => {
    const stats = statsByPath[targetPath];
    if (!stats) {
      const error = new Error('No such file') as Error & { code: number };
      error.code = 2;
      callback(error);
      return;
    }

    callback(null, stats);
  };
  sftp.createWriteStream = (targetPath, streamOptions): Writable => {
    const chunks: Buffer[] = [];
    writes.push(targetPath);
    return new Writable({
      write(chunk, _encoding, callback): void {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback): void {
        const content = Buffer.concat(chunks).toString('utf8');
        writtenContentByPath.set(targetPath, content);
        statsByPath[targetPath] = createTestSftpStats({
          size: Buffer.byteLength(content),
          mtime: 1_710_000_010,
        });
        statsByPath[targetPath].mode = 0o100000 | streamOptions.mode;
        callback();
      },
    });
  };
  sftp.rename = (sourcePath, targetPath, callback): void => {
    renames.push({ sourcePath, targetPath });
    if (options.renameError && renameErrorCount > 0) {
      renameErrorCount -= 1;
      callback(options.renameError);
      return;
    }

    const sourceStats = statsByPath[sourcePath] ?? statsByPath[targetPath];
    statsByPath[targetPath] = createTestSftpStats({
      size: sourceStats?.size ?? 0,
      mtime: sourceStats?.mtime ?? Math.trunc(Date.now() / 1000),
    });
    callback(null);
  };
  sftp.unlink = (targetPath, callback): void => {
    unlinks.push(targetPath);
    if (options.unlinkError) {
      callback(options.unlinkError);
      return;
    }

    delete statsByPath[targetPath];
    callback(null);
  };
  if (options.withPosixRename) {
    sftp.ext_openssh_rename = (sourcePath, targetPath, callback): void => {
      posixRenames.push({ sourcePath, targetPath });
      if (options.posixRenameError) {
        callback(options.posixRenameError);
        return;
      }

      const sourceStats = statsByPath[sourcePath] ?? statsByPath[targetPath];
      statsByPath[targetPath] = createTestSftpStats({
        size: sourceStats?.size ?? 0,
        mtime: sourceStats?.mtime ?? Math.trunc(Date.now() / 1000),
      });
      callback(null);
    };
  }

  return { posixRenames, sftp, unlinks, writes, writtenContentByPath, renames };
};

/**
 * Creates an SFTP mock for symbolic-link batch operation tests.
 *
 * @param existingPaths Remote paths that should appear as occupied.
 * @returns Mock SFTP wrapper and created symlink log.
 */
const createLinkSftpMock = (
  existingPaths: Iterable<string>,
): {
  sftp: TestLinkSftp;
  symlinks: Array<{ linkPath: string; targetPath: string }>;
} => {
  const occupiedPaths = new Set(existingPaths);
  const symlinks: Array<{ linkPath: string; targetPath: string }> = [];
  const sftp = new EventEmitter() as TestLinkSftp;

  sftp.stat = (targetPath, callback): void => {
    if (!occupiedPaths.has(targetPath)) {
      const error = new Error('No such file') as Error & { code: number };
      error.code = 2;
      callback(error);
      return;
    }

    callback(null, createTestSftpStats({ size: 1, mtime: 1_710_000_000 }));
  };
  sftp.symlink = (targetPath, linkPath, callback): void => {
    symlinks.push({ targetPath, linkPath });
    occupiedPaths.add(linkPath);
    callback(null);
  };

  return { sftp, symlinks };
};

/**
 * Creates an SFTP mock for remote rename tests.
 *
 * @param statsByPath Remote stats keyed by path.
 * @returns Mock SFTP wrapper and rename log.
 */
const createRenameSftpMock = (
  statsByPath: Record<string, TestSftpStats>,
): {
  renames: Array<{ sourcePath: string; targetPath: string }>;
  sftp: TestRenameSftp;
} => {
  const renames: Array<{ sourcePath: string; targetPath: string }> = [];
  const sftp = new EventEmitter() as TestRenameSftp;

  sftp.lstat = (targetPath, callback): void => {
    const stats = statsByPath[targetPath];
    if (!stats) {
      const error = new Error('No such file') as Error & { code: number };
      error.code = 2;
      callback(error);
      return;
    }

    callback(null, stats);
  };
  sftp.rename = (sourcePath, targetPath, callback): void => {
    renames.push({ sourcePath, targetPath });
    callback(null);
  };

  return { renames, sftp };
};

/**
 * Creates a local test directory inside the controlled SFTP temp root.
 *
 * @returns Absolute temp directory path.
 */
const createSftpTemporaryTestDirectory = async (): Promise<string> => {
  return fs.mkdtemp(path.join(TEST_SFTP_TEMP_ROOT_PATH, 'upload-test-'));
};

/**
 * Builds an unused local path inside the controlled SFTP temp root.
 *
 * @returns Absolute temp-root path that does not need to exist.
 */
const resolveUnusedSftpTemporaryTestPath = (): string => {
  return path.join(TEST_SFTP_TEMP_ROOT_PATH, 'unused-local-path');
};

/**
 * Creates one uploadable local temp file.
 *
 * @param fileName Local file name.
 * @param content File content.
 * @returns Local file path and cleanup callback.
 */
const createUploadableTempFile = async (
  fileName: string,
  content: string,
): Promise<{ cleanup: () => Promise<void>; localPath: string }> => {
  const temporaryDirectoryPath = await createSftpTemporaryTestDirectory();
  const localPath = path.join(temporaryDirectoryPath, fileName);
  await fs.writeFile(localPath, content, 'utf8');

  return {
    localPath,
    cleanup: async (): Promise<void> => {
      await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
    },
  };
};

test('normalizeSftpPathInput keeps SFTP paths POSIX-oriented', () => {
  assert.equal(normalizeSftpPathInput(undefined), '.');
  assert.equal(normalizeSftpPathInput(''), '.');
  assert.equal(normalizeSftpPathInput('/var/link/../log'), '/var/link/../log');
  assert.equal(normalizeSftpPathInput('/var/with space '), '/var/with space ');
  assert.equal(normalizeSftpPathInput('/var/back\\slash'), '/var/back\\slash');
  assert.equal(normalizeSftpPathInput('C:\\tmp\\site'), 'C:/tmp/site');
});

test('joinSftpPath builds stable remote child paths', () => {
  assert.equal(joinSftpPath('/', 'etc'), '/etc');
  assert.equal(joinSftpPath('/var/www', 'index.html'), '/var/www/index.html');
  assert.equal(joinSftpPath('.', 'relative'), 'relative');
  assert.equal(joinSftpPath('/var/link/..', 'file '), '/var/link/../file ');
  for (const directoryMarker of ['', '/', '//', '.', '..', '/dir/..', '/dir/./']) {
    assert.equal(isMutableSftpEntryPath(directoryMarker), false);
  }
  assert.equal(isMutableSftpEntryPath('/dir/link/../file '), true);
});

test('resolveSftpEntryType maps POSIX file bits', () => {
  assert.equal(resolveSftpEntryType(0o040755), 'directory');
  assert.equal(resolveSftpEntryType(0o100644), 'file');
  assert.equal(resolveSftpEntryType(0o120777), 'symlink');
  assert.equal(resolveSftpEntryType(0o010000), 'other');
});

test('resolveSftpEntryHiddenState detects dot-prefixed entries', () => {
  assert.equal(resolveSftpEntryHiddenState('.env', { mode: 0o100644 } as never), true);
  assert.equal(resolveSftpEntryHiddenState('.config', { mode: 0o040755 } as never), true);
  assert.equal(resolveSftpEntryHiddenState('visible.txt', { mode: 0o100644 } as never), false);
});

test('resolveSftpEntryHiddenState detects server-provided extended hidden markers', () => {
  assert.equal(
    resolveSftpEntryHiddenState('server-hidden.txt', {
      mode: 0o100644,
      extended: {
        'is-hidden': Buffer.from('true'),
      },
    } as never),
    true,
  );
  assert.equal(
    resolveSftpEntryHiddenState('server-visible.txt', {
      mode: 0o100644,
      extended: {
        hidden: 'false',
      },
    } as never),
    false,
  );
});

test('formatSftpPermissions returns symbolic permissions', () => {
  assert.equal(formatSftpPermissions(0o040755), 'drwxr-xr-x');
  assert.equal(formatSftpPermissions(0o100640), '-rw-r-----');
  assert.equal(formatSftpPermissions(0o120777), 'lrwxrwxrwx');
});

test('formatSftpPermissionOctal returns chmod-ready octal permissions', () => {
  assert.equal(formatSftpPermissionOctal(0o100644), '0644');
  assert.equal(formatSftpPermissionOctal(0o040755), '0755');
  assert.equal(formatSftpPermissionOctal(0o041755), '1755');
});

test('escapeSftpShellPath returns single-quoted shell tokens', () => {
  assert.equal(escapeSftpShellPath('/var/www/current'), "'/var/www/current'");
  assert.equal(escapeSftpShellPath("/tmp/it's here"), "'/tmp/it'\\''s here'");
});

test('SftpSessionService evicts sessions when SSH transport closes', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  registerTestSession(service, session);

  session.client.emit('close');

  assert.equal(session.isClosed, true);
  assert.equal(getTestInternals(service).sessions.has(session.sessionId), false);
  assert.deepEqual(await service.listDirectory(session.sessionId, '/'), { type: 'not-found' });
});

test('SftpSessionService closeSession remains idempotent for evicted sessions', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  let endCallCount = 0;
  session.client.end = (): void => {
    endCallCount += 1;
  };
  registerTestSession(service, session);

  assert.equal(await service.closeSession(session.sessionId), true);
  assert.equal(await service.closeSession(session.sessionId), false);
  assert.equal(session.isClosed, true);
  assert.equal(endCallCount, 1);
});

test('SftpSessionService times out a stalled mutation, poisons the session, and ignores its late callback', async () => {
  const service = createTestSftpSessionService(25);
  const session = createTestSftpSession();
  const sftp = new EventEmitter() as TestDeleteSftp;
  let sftpDestroyCallCount = 0;
  let clientDestroyCallCount = 0;
  let lateUnlinkCallback: ((error?: Error | null) => void) | undefined;

  sftp.lstat = (_targetPath, callback): void => {
    callback(null, createTestSftpStats({ size: 8, mtime: 1_710_000_000 }));
  };
  sftp.unlink = (_targetPath, callback): void => {
    lateUnlinkCallback = callback;
  };
  sftp.destroy = (): void => {
    sftpDestroyCallCount += 1;
  };
  session.client.destroy = (): void => {
    clientDestroyCallCount += 1;
  };
  session.sftp = sftp;
  registerTestSession(service, session);

  const result = await service.deleteEntry(session.sessionId, '/tmp/stalled.txt', false);

  assert.equal(result.type, 'failed');
  assert.equal(result.type === 'failed' ? result.operationErrorCode : undefined, SFTP_OPERATION_TIMEOUT_CODE);
  assert.equal(result.type === 'failed' ? result.outcomeUnknown : undefined, true);
  assert.match(result.type === 'failed' ? result.message : '', /^SFTP_OPERATION_TIMEOUT:/);
  assert.equal(session.isClosed, true);
  assert.equal(getTestInternals(service).sessions.has(session.sessionId), false);
  assert.equal(sftpDestroyCallCount, 1);
  assert.equal(clientDestroyCallCount, 1);

  lateUnlinkCallback?.(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sftpDestroyCallCount, 1);
  assert.equal(clientDestroyCallCount, 1);
});

test('SftpSessionService settles a pending mutation when the transport closes', async () => {
  const service = createTestSftpSessionService(1_000);
  const session = createTestSftpSession();
  const sftp = new EventEmitter() as TestDeleteSftp;
  let unlinkStarted = false;

  sftp.lstat = (_targetPath, callback): void => {
    callback(null, createTestSftpStats({ size: 8, mtime: 1_710_000_000 }));
  };
  sftp.unlink = (): void => {
    unlinkStarted = true;
  };
  sftp.destroy = (): void => undefined;
  session.sftp = sftp;
  registerTestSession(service, session);

  const resultPromise = service.deleteEntry(session.sessionId, '/tmp/disconnected.txt', false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unlinkStarted, true);

  session.client.emit('close');
  const result = await resultPromise;

  assert.equal(result.type, 'failed');
  assert.equal(result.type === 'failed' ? result.operationErrorCode : undefined, SFTP_TRANSPORT_CLOSED_CODE);
  assert.equal(result.type === 'failed' ? result.outcomeUnknown : undefined, true);
  assert.match(result.type === 'failed' ? result.message : '', /^SFTP_TRANSPORT_CLOSED:/);
});

test('SftpSessionService normalizes a raw transport callback failure without returning not-found', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const sftp = new EventEmitter() as TestDeleteSftp;
  let destroyCallCount = 0;

  sftp.lstat = (_targetPath, callback): void => {
    callback(null, createTestSftpStats({ size: 8, mtime: 1_710_000_000 }));
  };
  sftp.unlink = (_targetPath, callback): void => {
    callback(new Error('No response from server'));
  };
  sftp.destroy = (): void => {
    destroyCallCount += 1;
  };
  session.sftp = sftp;
  registerTestSession(service, session);

  const result = await service.deleteEntry(session.sessionId, '/tmp/no-response.txt', false);

  assert.equal(result.type, 'failed');
  assert.equal(result.type === 'failed' ? result.operationErrorCode : undefined, SFTP_TRANSPORT_CLOSED_CODE);
  assert.equal(result.type === 'failed' ? result.outcomeUnknown : undefined, true);
  assert.equal(destroyCallCount, 1);
  assert.equal(session.isClosed, true);
});

test('SftpSessionService listDirectory includes symlink target metadata', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  session.sftp = createListSftpMock(
    {
      '/srv': [
        {
          filename: 'app-link',
          attrs: createTestSftpStats({ size: 7, mtime: 1_710_000_000, entryType: 'symlink' }),
        },
        {
          filename: 'config-link',
          attrs: createTestSftpStats({ size: 11, mtime: 1_710_000_000, entryType: 'symlink' }),
        },
        {
          filename: 'missing-link',
          attrs: createTestSftpStats({ size: 8, mtime: 1_710_000_000, entryType: 'symlink' }),
        },
        {
          filename: 'notes.txt',
          attrs: createTestSftpStats({ size: 64, mtime: 1_710_000_000 }),
        },
      ],
    },
    {
      '/srv/app-link': '/opt/app',
      '/srv/config-link': 'config.json',
      '/srv/missing-link': '/missing',
    },
    {
      '/opt/app': createTestSftpStats({ size: 0, mtime: 1_710_000_001, entryType: 'directory' }),
      '/srv/config.json': createTestSftpStats({ size: 128, mtime: 1_710_000_002 }),
    },
  );
  registerTestSession(service, session);

  const result = await service.listDirectory(session.sessionId, '/srv');

  assert.equal(result.type, 'success');
  if (result.type !== 'success') {
    return;
  }

  const appLink = result.entries.find((entry) => entry.path === '/srv/app-link');
  const configLink = result.entries.find((entry) => entry.path === '/srv/config-link');
  const missingLink = result.entries.find((entry) => entry.path === '/srv/missing-link');
  const notesFile = result.entries.find((entry) => entry.path === '/srv/notes.txt');

  assert.equal(appLink?.symlinkTarget?.status, 'exists');
  assert.equal(appLink?.symlinkTarget?.type, 'directory');
  assert.equal(appLink?.symlinkTarget?.resolvedPath, '/opt/app');
  assert.equal(configLink?.symlinkTarget?.status, 'exists');
  assert.equal(configLink?.symlinkTarget?.type, 'file');
  assert.equal(configLink?.symlinkTarget?.resolvedPath, '/srv/config.json');
  assert.equal(missingLink?.symlinkTarget?.status, 'broken');
  assert.equal(missingLink?.symlinkTarget?.resolvedPath, '/missing');
  assert.equal(notesFile?.symlinkTarget, undefined);
});

test('SftpSessionService runBatchOperation creates symlinks with copy-style conflict suffixes', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const linkSftp = createLinkSftpMock(['/target/app.log']);
  session.sftp = linkSftp.sftp;
  registerTestSession(service, session);

  const result = await service.runBatchOperation(session.sessionId, {
    operation: 'link',
    targetDirectoryPath: '/target',
    entries: [{ path: '/source/app.log', type: 'file' }],
  });

  assert.equal(result.type, 'success');
  if (result.type !== 'success') {
    return;
  }

  assert.equal(result.operation, 'link');
  assert.equal(result.completedCount, 1);
  assert.deepEqual(linkSftp.symlinks, [{ targetPath: '/source/app.log', linkPath: '/target/app copy.log' }]);
  assert.deepEqual(result.results, [
    {
      path: '/source/app.log',
      type: 'file',
      targetPath: '/target/app copy.log',
      status: 'success',
    },
  ]);
});

test('SftpSessionService runBatchOperation requires a target directory for link operations', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  session.sftp = createLinkSftpMock([]).sftp;
  registerTestSession(service, session);

  const result = await service.runBatchOperation(session.sessionId, {
    operation: 'link',
    entries: [{ path: '/source/app.log', type: 'file' }],
  });

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.batchTargetRequired',
  });
});

test('SftpSessionService renameEntry rejects moving a directory into its descendant', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const renameSftp = createRenameSftpMock({
    '/srv/app': createTestSftpStats({ size: 0, mtime: 1_710_000_000, isFile: false }),
  });
  session.sftp = renameSftp.sftp;
  registerTestSession(service, session);

  const result = await service.renameEntry(session.sessionId, '/srv/app', '/srv/app/logs/app');

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.moveIntoSelfUnsupported',
  });
  assert.deepEqual(renameSftp.renames, []);
});

test('SftpSessionService downloadFile writes large content and records completed byte progress', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/srv/archive.bin';
  const transferId = 'f57aa040-3138-4bf5-b329-ec4c9242fbb8';
  const content = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const localDirectory = await fs.mkdtemp(path.join(TEST_SFTP_TEMP_ROOT_PATH, 'download-success-'));
  const localPath = path.join(localDirectory, 'archive.bin');
  session.sftp = createDownloadSftpMock(remotePath, content);
  registerTestSession(service, session);

  try {
    const result = await service.downloadFile(session.sessionId, remotePath, localPath, transferId);

    assert.deepEqual(result, {
      type: 'success',
      sessionId: session.sessionId,
      path: remotePath,
      localPath,
      size: content.byteLength,
    });
    assert.deepEqual(await fs.readFile(localPath), content);
    const progress = service.getTransferProgress(transferId);
    assert.equal(progress?.transferId, transferId);
    assert.equal(progress?.direction, 'download');
    assert.equal(progress?.status, 'completed');
    assert.equal(progress?.transferredBytes, content.byteLength);
    assert.equal(progress?.totalBytes, content.byteLength);
    assert.ok(progress?.startedAt);
    assert.ok(progress?.updatedAt);
    assert.ok(progress?.finishedAt);
  } finally {
    await fs.rm(localDirectory, { force: true, recursive: true });
  }
});

test('SftpSessionService downloadFile reports rolling speed while a transfer is active', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/srv/slow-archive.bin';
  const transferId = 'd9e06fa8-88f3-43d5-87c5-e42139d58abc';
  const chunk = Buffer.alloc(64 * 1024, 0x2a);
  const content = Buffer.concat([chunk, chunk, chunk]);
  const localDirectory = await fs.mkdtemp(path.join(TEST_SFTP_TEMP_ROOT_PATH, 'download-speed-'));
  const localPath = path.join(localDirectory, 'slow-archive.bin');
  const sftp = createDownloadSftpMock(remotePath, content);
  let signalSpeedSample: (() => void) | undefined;
  const speedSampleReady = new Promise<void>((resolve) => {
    signalSpeedSample = resolve;
  });
  sftp.createReadStream = (): Readable => {
    return Readable.from(
      (async function* createDelayedChunks(): AsyncGenerator<Buffer> {
        yield chunk;
        await new Promise((resolve) => setTimeout(resolve, 300));
        yield chunk;
        signalSpeedSample?.();
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield chunk;
      })(),
    );
  };
  session.sftp = sftp;
  registerTestSession(service, session);

  try {
    const downloadPromise = service.downloadFile(session.sessionId, remotePath, localPath, transferId);
    await speedSampleReady;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const activeProgress = service.getTransferProgress(transferId);
    assert.equal(activeProgress?.status, 'running');
    assert.ok((activeProgress?.transferredBytes ?? 0) >= chunk.byteLength * 2);
    assert.ok((activeProgress?.bytesPerSecond ?? 0) > 0);
    assert.equal((await downloadPromise).type, 'success');
  } finally {
    await fs.rm(localDirectory, { force: true, recursive: true });
  }
});

test('SftpSessionService downloadFile reports closed transports and removes partial local files', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/srv/interrupted.bin';
  const transferId = '7e33e12b-b1c8-46c6-9e6f-ff8c02ab7d8d';
  const content = Buffer.alloc(1024 * 1024, 0x41);
  const localDirectory = await fs.mkdtemp(path.join(TEST_SFTP_TEMP_ROOT_PATH, 'download-failure-'));
  const localPath = path.join(localDirectory, 'interrupted.bin');
  const sftp = createDownloadSftpMock(remotePath, content);
  let didRead = false;
  sftp.createReadStream = (): Readable => {
    return new Readable({
      read(): void {
        if (didRead) {
          return;
        }
        didRead = true;
        this.push(content.subarray(0, 64 * 1024));
        this.destroy(new Error('connection lost'));
      },
    });
  };
  session.sftp = sftp;
  registerTestSession(service, session);

  try {
    const result = await service.downloadFile(session.sessionId, remotePath, localPath, transferId);

    assert.equal(result.type, 'failed');
    assert.equal(result.type === 'failed' ? result.operationErrorCode : undefined, SFTP_TRANSPORT_CLOSED_CODE);
    assert.equal(result.type === 'failed' ? result.outcomeUnknown : undefined, undefined);
    assert.equal(session.isClosed, true);
    assert.equal(
      await fs
        .stat(localPath)
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.deepEqual(await fs.readdir(localDirectory), []);
    const progress = service.getTransferProgress(transferId);
    assert.equal(progress?.status, 'failed');
    assert.match(progress?.errorMessage ?? '', /^SFTP_TRANSPORT_CLOSED:/);
  } finally {
    await fs.rm(localDirectory, { force: true, recursive: true });
  }
});

test('SftpSessionService times out a stalled download stream and removes its partial local file', async () => {
  const service = createTestSftpSessionService(25);
  const session = createTestSftpSession();
  const remotePath = '/srv/stalled.bin';
  const transferId = '00616254-0809-44a0-996c-944954d65f5f';
  const localDirectory = await fs.mkdtemp(path.join(TEST_SFTP_TEMP_ROOT_PATH, 'download-stall-'));
  const localPath = path.join(localDirectory, 'stalled.bin');
  const sftp = createDownloadSftpMock(remotePath, Buffer.alloc(128));
  const stalledReadStream = new Readable({
    read(): void {
      // Intentionally never emits data or EOF.
    },
  });
  let destroyCallCount = 0;
  sftp.createReadStream = (): Readable => stalledReadStream;
  sftp.destroy = (): void => {
    destroyCallCount += 1;
  };
  session.sftp = sftp;
  registerTestSession(service, session);

  try {
    const result = await service.downloadFile(session.sessionId, remotePath, localPath, transferId);

    assert.equal(result.type, 'failed');
    assert.equal(result.type === 'failed' ? result.operationErrorCode : undefined, SFTP_OPERATION_TIMEOUT_CODE);
    assert.equal(result.type === 'failed' ? result.outcomeUnknown : undefined, undefined);
    assert.equal(destroyCallCount, 1);
    assert.equal(stalledReadStream.destroyed, true);
    assert.deepEqual(await fs.readdir(localDirectory), []);
    assert.equal(service.getTransferProgress(transferId)?.status, 'failed');
  } finally {
    await fs.rm(localDirectory, { force: true, recursive: true });
  }
});

test('SftpSessionService uploadFile replaces a matching remote regular file', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/index.html';
  const openedMtime = 1_710_000_000;
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 12, mtime: openedMtime }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const uploadableFile = await createUploadableTempFile('index.html', 'locally edited');
  const transferId = 'bdcf495c-9d31-4bc6-8abf-57f94a41718f';

  try {
    const result = await service.uploadFile(
      session.sessionId,
      remotePath,
      uploadableFile.localPath,
      {
        size: 12,
        modifiedAt: new Date(openedMtime * 1000).toISOString(),
      },
      { transferId },
    );

    assert.deepEqual(result, {
      type: 'success',
      sessionId: session.sessionId,
      path: remotePath,
      size: 14,
      modifiedAt: new Date(1_710_000_010 * 1000).toISOString(),
    });
    assert.equal(uploadSftp.writes.length, 1);
    assert.match(uploadSftp.writes[0] ?? '', /^\/var\/www\/\.index\.html\.cosmosh-.+\.tmp$/);
    assert.equal(uploadSftp.writtenContentByPath.get(uploadSftp.writes[0] ?? ''), 'locally edited');
    assert.deepEqual(uploadSftp.renames, [{ sourcePath: uploadSftp.writes[0], targetPath: remotePath }]);
    const progress = service.getTransferProgress(transferId);
    assert.equal(progress?.direction, 'upload');
    assert.equal(progress?.status, 'completed');
    assert.equal(progress?.transferredBytes, 14);
    assert.equal(progress?.totalBytes, 14);
  } finally {
    await uploadableFile.cleanup();
  }
});

test('SftpSessionService uploadFile creates a new remote file without an opening snapshot', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/new-file.txt';
  const uploadSftp = createUploadSftpMock({});
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const uploadableFile = await createUploadableTempFile('new-file.txt', 'new upload');

  try {
    const result = await service.uploadFile(session.sessionId, remotePath, uploadableFile.localPath);

    assert.equal(result.type, 'success');
    assert.deepEqual(uploadSftp.writes, [remotePath]);
    assert.deepEqual(uploadSftp.renames, []);
    assert.equal(uploadSftp.writtenContentByPath.get(remotePath), 'new upload');
  } finally {
    await uploadableFile.cleanup();
  }
});

test('SftpSessionService uploadFile requires confirmation before replacing an existing upload target', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/existing.txt';
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 8, mtime: 1_710_000_000 }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const result = await service.uploadFile(session.sessionId, remotePath, resolveUnusedSftpTemporaryTestPath());

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.fileUploadTargetExists',
    reason: 'remote-conflict',
  });
  assert.deepEqual(uploadSftp.writes, []);
  assert.deepEqual(uploadSftp.renames, []);
});

test('SftpSessionService uploadFile treats a deleted opened file as a remote conflict', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/deleted-after-open.txt';
  const uploadSftp = createUploadSftpMock({});
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const result = await service.uploadFile(session.sessionId, remotePath, resolveUnusedSftpTemporaryTestPath(), {
    size: 8,
    modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
  });

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.fileUploadRemoteChanged',
    reason: 'remote-conflict',
  });
  assert.deepEqual(uploadSftp.writes, []);
});

test('SftpSessionService uploadFile prefers OpenSSH posix rename when replacing existing files', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/index.html';
  const openedMtime = 1_710_000_000;
  const uploadSftp = createUploadSftpMock(
    {
      [remotePath]: createTestSftpStats({ size: 12, mtime: openedMtime }),
    },
    {
      withPosixRename: true,
    },
  );
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const uploadableFile = await createUploadableTempFile('index.html', 'posix edited');

  try {
    const result = await service.uploadFile(session.sessionId, remotePath, uploadableFile.localPath, {
      size: 12,
      modifiedAt: new Date(openedMtime * 1000).toISOString(),
    });

    assert.equal(result.type, 'success');
    assert.equal(uploadSftp.posixRenames.length, 1);
    assert.deepEqual(uploadSftp.renames, []);
    assert.equal(uploadSftp.writtenContentByPath.get(uploadSftp.writes[0] ?? ''), 'posix edited');
  } finally {
    await uploadableFile.cleanup();
  }
});

test('SftpSessionService uploadFile falls back when servers reject overwrite rename with failure', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/index.html';
  const openedMtime = 1_710_000_000;
  const uploadSftp = createUploadSftpMock(
    {
      [remotePath]: createTestSftpStats({ size: 12, mtime: openedMtime }),
    },
    {
      renameError: new Error('failure'),
      renameErrorCount: 1,
    },
  );
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const uploadableFile = await createUploadableTempFile('index.html', 'fallback edited');

  try {
    const result = await service.uploadFile(session.sessionId, remotePath, uploadableFile.localPath, {
      size: 12,
      modifiedAt: new Date(openedMtime * 1000).toISOString(),
    });

    assert.equal(result.type, 'success');
    assert.equal(uploadSftp.renames.length, 2);
    assert.deepEqual(uploadSftp.unlinks, [remotePath]);
    assert.deepEqual(uploadSftp.renames[1], { sourcePath: uploadSftp.writes[0], targetPath: remotePath });
  } finally {
    await uploadableFile.cleanup();
  }
});

test('SftpSessionService uploadFile blocks fallback replacement if remote changed after first rename failure', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/index.html';
  const openedMtime = 1_710_000_000;
  const uploadSftp = createUploadSftpMock(
    {
      [remotePath]: createTestSftpStats({ size: 12, mtime: openedMtime }),
    },
    {
      renameError: new Error('failure'),
      renameErrorCount: 1,
    },
  );
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const uploadableFile = await createUploadableTempFile('index.html', 'conflict edited');

  try {
    const originalStat = uploadSftp.sftp.stat;
    let statCallCount = 0;
    uploadSftp.sftp.stat = (targetPath, callback): void => {
      statCallCount += 1;
      if (targetPath === remotePath && statCallCount >= 2) {
        callback(null, createTestSftpStats({ size: 13, mtime: 1_710_000_001 }));
        return;
      }

      originalStat(targetPath, callback);
    };

    const result = await service.uploadFile(session.sessionId, remotePath, uploadableFile.localPath, {
      size: 12,
      modifiedAt: new Date(openedMtime * 1000).toISOString(),
    });

    assert.deepEqual(result, {
      type: 'failed',
      message: 'errors.sftp.fileUploadRemoteChanged',
      reason: 'remote-conflict',
    });
    assert.deepEqual(uploadSftp.unlinks, [uploadSftp.writes[0]]);
    assert.equal(uploadSftp.renames.length, 1);
  } finally {
    await uploadableFile.cleanup();
  }
});

test('SftpSessionService uploadFile blocks remote size or mtime conflicts before writing', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/app.js';
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 13, mtime: 1_710_000_005 }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const result = await service.uploadFile(session.sessionId, remotePath, resolveUnusedSftpTemporaryTestPath(), {
    size: 12,
    modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
  });

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.fileUploadRemoteChanged',
    reason: 'remote-conflict',
  });
  assert.deepEqual(uploadSftp.writes, []);
  assert.deepEqual(uploadSftp.renames, []);
});

test('SftpSessionService uploadFile overwrites after explicit conflict confirmation', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/app.js';
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 13, mtime: 1_710_000_005 }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const uploadableFile = await createUploadableTempFile('app.js', 'overwrite edited');

  try {
    const result = await service.uploadFile(
      session.sessionId,
      remotePath,
      uploadableFile.localPath,
      {
        size: 12,
        modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
      },
      {
        overwrite: true,
      },
    );

    assert.equal(result.type, 'success');
    assert.equal(uploadSftp.writes.length, 1);
    assert.deepEqual(uploadSftp.renames, [{ sourcePath: uploadSftp.writes[0], targetPath: remotePath }]);
    assert.equal(uploadSftp.writtenContentByPath.get(uploadSftp.writes[0] ?? ''), 'overwrite edited');
  } finally {
    await uploadableFile.cleanup();
  }
});

test('SftpSessionService uploadFile rejects non-file remote targets', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/var/www/assets';
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 0, mtime: 1_710_000_000, isFile: false }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const result = await service.uploadFile(session.sessionId, remotePath, resolveUnusedSftpTemporaryTestPath(), {
    size: 0,
    modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
  });

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.fileUploadUnsupported',
  });
  assert.deepEqual(uploadSftp.writes, []);
  assert.deepEqual(uploadSftp.renames, []);
});

test('SftpSessionService uploadFile reports missing sessions without touching the filesystem', async () => {
  const service = createTestSftpSessionService();

  const result = await service.uploadFile('missing-session', '/tmp/file.txt', resolveUnusedSftpTemporaryTestPath(), {
    size: 1,
    modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
  });

  assert.deepEqual(result, { type: 'not-found' });
});

test('SftpSessionService uploadFile requires a local file path', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/tmp/file.txt';
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 1, mtime: 1_710_000_000 }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const result = await service.uploadFile(session.sessionId, remotePath, '', {
    size: 1,
    modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
  });

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.localPathRequired',
  });
  assert.deepEqual(uploadSftp.writes, []);
  assert.deepEqual(uploadSftp.renames, []);
});

test('SftpSessionService uploadFile rejects local paths outside the controlled SFTP temp root', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/tmp/file.txt';
  const uploadSftp = createUploadSftpMock({
    [remotePath]: createTestSftpStats({ size: 1, mtime: 1_710_000_000 }),
  });
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const result = await service.uploadFile(session.sessionId, remotePath, path.join(os.tmpdir(), 'outside.txt'), {
    size: 1,
    modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
  });

  assert.deepEqual(result, {
    type: 'failed',
    message: 'errors.sftp.localFileReadUnsupported',
  });
  assert.deepEqual(uploadSftp.writes, []);
  assert.deepEqual(uploadSftp.renames, []);
});

test(
  'SftpSessionService uploadFile rejects symlink paths inside the controlled SFTP temp root',
  { skip: process.platform === 'win32' ? 'Windows symlink creation requires elevated host policy.' : false },
  async () => {
    const service = createTestSftpSessionService();
    const session = createTestSftpSession();
    const remotePath = '/tmp/file.txt';
    const uploadSftp = createUploadSftpMock({
      [remotePath]: createTestSftpStats({ size: 1, mtime: 1_710_000_000 }),
    });
    session.sftp = uploadSftp.sftp;
    registerTestSession(service, session);

    const temporaryDirectoryPath = await createSftpTemporaryTestDirectory();
    const symlinkTargetPath = path.join(temporaryDirectoryPath, 'target.txt');
    const localPath = path.join(temporaryDirectoryPath, 'link.txt');
    await fs.writeFile(symlinkTargetPath, 'hello', 'utf8');
    await fs.symlink(symlinkTargetPath, localPath);

    try {
      const result = await service.uploadFile(session.sessionId, remotePath, localPath, {
        size: 1,
        modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
      });

      assert.deepEqual(result, {
        type: 'failed',
        message: 'errors.sftp.localFileReadUnsupported',
      });
      assert.deepEqual(uploadSftp.writes, []);
      assert.deepEqual(uploadSftp.renames, []);
    } finally {
      await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
    }
  },
);

test('SftpSessionService uploadFile keeps the primary error when temp cleanup also fails', async () => {
  const service = createTestSftpSessionService();
  const session = createTestSftpSession();
  const remotePath = '/tmp/file.txt';
  const uploadSftp = createUploadSftpMock(
    {
      [remotePath]: createTestSftpStats({ size: 5, mtime: 1_710_000_000 }),
    },
    {
      renameError: new Error('rename failed'),
      unlinkError: new Error('unlink failed'),
    },
  );
  session.sftp = uploadSftp.sftp;
  registerTestSession(service, session);

  const temporaryDirectoryPath = await createSftpTemporaryTestDirectory();
  const localPath = path.join(temporaryDirectoryPath, 'file.txt');
  await fs.writeFile(localPath, 'hello', 'utf8');

  try {
    const result = await service.uploadFile(session.sessionId, remotePath, localPath, {
      size: 5,
      modifiedAt: new Date(1_710_000_000 * 1000).toISOString(),
    });

    assert.deepEqual(result, {
      type: 'failed',
      message: 'rename failed',
    });
    assert.deepEqual(uploadSftp.unlinks, [uploadSftp.writes[0]]);
  } finally {
    await fs.rm(temporaryDirectoryPath, { force: true, recursive: true });
  }
});
