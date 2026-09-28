import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  API_CODES,
  type ApiSftpArchiveCapabilitiesData,
  type ApiSftpArchiveConflictResolution,
  type ApiSftpArchiveOperationData,
  type ApiSftpArchiveOperationRequest,
  type ApiSftpStartTaskRequest,
  type ApiSftpTaskData,
  type ApiSftpTaskErrorCode,
  type ApiSftpTaskOperationType,
  type ApiSftpTaskResult,
  sortSftpEntriesByBrowserOrder,
} from '@cosmosh/api-contract';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';

import type { AuditEventService } from '../audit/service.js';
import type { AuditEventInput } from '../audit/types.js';
import { createI18n, type I18nInstance, type Locale } from '../i18n-bridge.js';
import { buildSshCompressionAlgorithms } from '../ssh/compression.js';
import { decryptSensitiveValue } from '../ssh/crypto.js';
import { prepareSshProxyTransport, SshProxyConnectionError, type SshProxyMetadata } from '../ssh/proxy.js';
import { quotePosixShellToken, SftpArchiveError, SftpArchiveService } from './archive-service.js';
import {
  isSftpOperationFailure,
  runGuardedSftpOperation,
  SFTP_OPERATION_TIMEOUT_CODE,
  SFTP_TRANSPORT_CLOSED_CODE,
  SftpOperationFailure,
  type SftpOperationFailureCode,
  type SftpOperationGuardContext,
  type SftpOperationImpact,
} from './operation-guard.js';
import {
  type SftpScheduledTask,
  type SftpTaskFailure,
  type SftpTaskResources,
  type SftpTaskRunOutcome,
  SftpTaskScheduler,
  type SftpTaskSnapshot,
} from './task-scheduler.js';

type GetDbClient = () => PrismaClient;

const SFTP_TEMP_ROOT_ENV_NAME = 'COSMOSH_SFTP_TEMP_ROOT';
const DEFAULT_SFTP_OPERATION_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_SFTP_OPERATION_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SFTP_TASK_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const SFTP_TASK_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SFTP_TASK_RECORD_LIMIT_PER_SESSION = 512;
const SFTP_TRANSFER_RETENTION_MS = 60_000;
const SFTP_TRANSFER_SPEED_SAMPLE_INTERVAL_MS = 250;
const SFTP_TASK_ERROR_CODES = new Set<ApiSftpTaskErrorCode>([
  API_CODES.sftpTaskDeadlineExceeded,
  API_CODES.sftpOperationTimeout,
  API_CODES.sftpTransportClosed,
  API_CODES.sftpSessionNotFound,
  API_CODES.sftpOperationFailed,
  API_CODES.sftpUploadConflict,
  API_CODES.sftpValidationFailed,
]);
const SFTP_TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTCONN',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

type SshServerWithKeychain = Prisma.SshServerGetPayload<{
  include: {
    keychain: true;
  };
}>;

export type CreateSftpSessionInput = {
  locale: Locale;
  requestId?: string;
  serverId: string;
  initialPath?: string;
  connectTimeoutSec: number;
  strictHostKey?: boolean;
  systemProxyRules?: string;
};

export type SftpEntryType = 'directory' | 'file' | 'symlink' | 'other';

/**
 * Internal lifecycle metadata retained until the HTTP contract can expose stable task failures.
 */
export type SftpOperationFailureMetadata = {
  operationErrorCode?: SftpOperationFailureCode;
  outcomeUnknown?: boolean;
};

/**
 * Non-recursive metadata shared by SFTP directory lists and detail views.
 */
export type SftpEntry = {
  name: string;
  path: string;
  parentPath?: string;
  type: SftpEntryType;
  size: number;
  mode: number;
  permissions: string;
  permissionOctal: string;
  uid: number;
  gid: number;
  modifiedAt: string;
  accessedAt: string;
  extension: string;
  shellEscapedPath: string;
  isHidden: boolean;
  longname?: string;
  symlinkTarget?: SftpSymlinkTarget;
};

/**
 * Reachability state for a symbolic link target.
 */
export type SftpSymlinkTargetStatus = 'exists' | 'broken' | 'permission-denied' | 'unknown';

/**
 * Metadata resolved from readlink/stat for a symbolic link target.
 */
export type SftpSymlinkTarget = {
  status: SftpSymlinkTargetStatus;
  path?: string;
  resolvedPath?: string;
  isAbsolute?: boolean;
  type?: SftpEntryType;
  size?: number;
  mode?: number;
  permissions?: string;
  permissionOctal?: string;
  modifiedAt?: string;
  accessedAt?: string;
  message?: string;
};

/**
 * Per-entry status returned by the details endpoint.
 */
export type SftpEntryDetailsItemStatus = 'success' | 'failed';

/**
 * Detailed metadata result for one requested SFTP path.
 */
export type SftpEntryDetailsItem = {
  path: string;
  status: SftpEntryDetailsItemStatus;
  entry?: SftpEntry;
  message?: string;
} & SftpOperationFailureMetadata;

/**
 * Batch operation modes supported by one SFTP API request.
 */
export type SftpBatchOperation = 'copy' | 'move' | 'delete' | 'link';

/**
 * Remote entry descriptor accepted by the SFTP batch operation endpoint.
 */
export type SftpBatchOperationEntry = {
  path: string;
  type: SftpEntryType;
};

/**
 * Per-entry execution status reported by SFTP batch operations.
 */
export type SftpBatchOperationItemStatus = 'success' | 'failed' | 'skipped';

/**
 * Per-entry execution result reported by SFTP batch operations.
 */
export type SftpBatchOperationItemResult = {
  path: string;
  type: SftpEntryType;
  targetPath?: string;
  status: SftpBatchOperationItemStatus;
  message?: string;
} & SftpOperationFailureMetadata;

/**
 * Normalized batch operation input used by the SFTP session service.
 */
export type RunSftpBatchOperationInput = {
  operation: SftpBatchOperation;
  entries: SftpBatchOperationEntry[];
  targetDirectoryPath?: string;
};

export type CreateSftpSessionResult =
  | {
      type: 'success';
      sessionId: string;
      serverId: string;
      initialPath: string;
      currentPath: string;
    }
  | {
      type: 'not-found';
    }
  | {
      type: 'host-untrusted';
      serverId: string;
      host: string;
      port: number;
      algorithm: 'sha256';
      fingerprint: string;
    }
  | ({
      type: 'failed';
      message: string;
    } & SftpOperationFailureMetadata);

export type ListSftpDirectoryResult =
  | {
      type: 'success';
      sessionId: string;
      path: string;
      parentPath?: string;
      entries: SftpEntry[];
    }
  | {
      type: 'not-found';
    }
  | ({
      type: 'failed';
      message: string;
    } & SftpOperationFailureMetadata);

/**
 * Result envelope for fetching detailed metadata for selected SFTP entries.
 */
export type GetSftpEntryDetailsResult =
  | {
      type: 'success';
      sessionId: string;
      requestedCount: number;
      entries: SftpEntryDetailsItem[];
    }
  | {
      type: 'not-found';
    };

export type SftpOperationResult =
  | {
      type: 'success';
      sessionId: string;
      path: string;
      targetPath?: string;
      size?: number;
      modifiedAt?: string;
    }
  | {
      type: 'not-found';
    }
  | ({
      type: 'failed';
      message: string;
      reason?: 'remote-conflict';
    } & SftpOperationFailureMetadata);

export type SftpBatchOperationResult =
  | {
      type: 'success';
      sessionId: string;
      operation: SftpBatchOperation;
      totalCount: number;
      completedCount: number;
      failedCount: number;
      skippedCount: number;
      stoppedOnFailure: boolean;
      results: SftpBatchOperationItemResult[];
    }
  | {
      type: 'not-found';
    }
  | ({
      type: 'failed';
      message: string;
    } & SftpOperationFailureMetadata);

/**
 * Submission result returned by the asynchronous SFTP task boundary.
 */
export type StartSftpTaskResult =
  | {
      type: 'success';
      task: ApiSftpTaskData;
    }
  | {
      type: 'not-found';
    }
  | {
      type: 'failed';
      message: string;
    };

export type ReadSftpFileResult =
  | {
      type: 'success';
      sessionId: string;
      path: string;
      content: string;
      size: number;
      truncated: boolean;
    }
  | {
      type: 'not-found';
    }
  | ({
      type: 'failed';
      message: string;
    } & SftpOperationFailureMetadata);

export type DownloadSftpFileResult =
  | {
      type: 'success';
      sessionId: string;
      path: string;
      localPath: string;
      size: number;
    }
  | {
      type: 'not-found';
    }
  | ({
      type: 'failed';
      message: string;
    } & SftpOperationFailureMetadata);

export type SftpTransferDirection = 'download' | 'upload';

export type SftpTransferStatus = 'running' | 'completed' | 'failed';

/**
 * Public progress snapshot for one active or recently completed byte transfer.
 */
export type SftpTransferProgress = {
  transferId: string;
  direction: SftpTransferDirection;
  status: SftpTransferStatus;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  errorMessage?: string;
};

type SftpTransferRecord = {
  transferId: string;
  direction: SftpTransferDirection;
  status: SftpTransferStatus;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  errorMessage?: string;
  lastSpeedSampleAt: number;
  lastSpeedSampleBytes: number;
};

export type UploadSftpFileConflictSnapshot = {
  size: number;
  modifiedAt: string;
};

export type UploadSftpFileResult = SftpOperationResult;

export type WriteSftpFileResult = SftpOperationResult;

export type UploadSftpFileOptions = {
  overwrite?: boolean;
  transferId?: string;
};

type RemoteFileReplacementOptions = {
  expectedRemoteSnapshot?: UploadSftpFileConflictSnapshot;
};

/**
 * Error marker used when upload replacement discovers that the remote file changed.
 */
class SftpRemoteConflictError extends Error {
  /**
   * Creates a typed remote-conflict error for API mapping.
   *
   * @param message Localized conflict message.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'SftpRemoteConflictError';
  }
}

type OpenSftpResult =
  | {
      type: 'ready';
      client: Client;
      sftp: SFTPWrapper;
      proxyMetadata: SshProxyMetadata;
    }
  | {
      type: 'host-untrusted';
      fingerprint: string;
      message: string;
      proxyMetadata?: SshProxyMetadata;
    }
  | {
      type: 'failed';
      message: string;
      proxyMetadata?: SshProxyMetadata;
    };

type SftpLiveSession = {
  sessionId: string;
  serverId: string;
  client: Client;
  sftp: SFTPWrapper;
  isClosed: boolean;
  t: I18nInstance['t'];
};

type SftpPublicTaskRecord = {
  operation: ApiSftpTaskOperationType;
  remotePaths: readonly string[];
  transferId?: string;
  handle: SftpScheduledTask<ApiSftpTaskResult, ApiSftpTaskResult>;
  released: boolean;
  retentionTimer?: NodeJS.Timeout;
};

type CoordinatedSftpOperationResult =
  | {
      type: 'success';
    }
  | {
      type: 'not-found';
    }
  | ({
      type: 'failed';
      message: string;
      reason?: 'remote-conflict';
    } & SftpOperationFailureMetadata);

const SFTP_READ_LIGHT_RESOURCES: SftpTaskResources = {
  impact: 'read',
  workload: 'light',
  exclusive: false,
};

const SFTP_READ_HEAVY_RESOURCES: SftpTaskResources = {
  impact: 'read',
  workload: 'heavy',
  exclusive: false,
};

const SFTP_MUTATION_LIGHT_RESOURCES: SftpTaskResources = {
  impact: 'mutation',
  workload: 'light',
  exclusive: false,
};

const SFTP_MUTATION_HEAVY_RESOURCES: SftpTaskResources = {
  impact: 'mutation',
  workload: 'heavy',
  exclusive: false,
};

const SFTP_ARCHIVE_EXCLUSIVE_RESOURCES: SftpTaskResources = {
  impact: 'lifecycle',
  workload: 'heavy',
  exclusive: true,
};

type SftpDirectoryEntry = {
  filename: string;
  longname?: string;
  attrs: Stats;
};

type SftpReadlinkWrapper = SFTPWrapper & {
  readlink(targetPath: string, callback: (error: Error | undefined | null, linkString: string) => void): void;
};

type SftpSymlinkWrapper = SFTPWrapper & {
  symlink(targetPath: string, linkPath: string, callback: (error: Error | undefined | null) => void): void;
};

type SftpOpenSshExtensions = {
  ext_openssh_rename?(
    sourcePath: string,
    targetPath: string,
    callback: (error?: Error | null | undefined) => void,
  ): void;
};

type SftpOperationCallback<T> = (error: Error | undefined | null, value?: T) => void;

const POSIX_PATH = path.posix;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;
const DEFAULT_READ_FILE_MAX_BYTES = 256 * 1024;
const MAX_READ_FILE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_FILE_CONTENT_BYTES = MAX_READ_FILE_MAX_BYTES;

type SftpStatsWithExtendedAttributes = Stats & {
  readonly extended?: unknown;
};

const HIDDEN_EXTENDED_ATTRIBUTE_NAMES = new Set([
  'hidden',
  'ishidden',
  'filehidden',
  'systemhidden',
  'doshidden',
  'attributehidden',
  'attributeshidden',
  'comapplefinderinfohidden',
]);

/**
 * Checks whether an unknown value is a plain record.
 *
 * @param value Candidate value.
 * @returns Whether the value can be safely inspected as an object map.
 */
const isUnknownRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Normalizes an extended attribute key for defensive hidden-marker matching.
 *
 * @param key Raw server-provided extended attribute key.
 * @returns Lowercase key without separators or namespace punctuation.
 */
const normalizeSftpExtendedAttributeName = (key: string): string => {
  return key.toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
};

/**
 * Parses a hidden marker payload returned through SFTP extended attributes.
 *
 * @param value Raw extended attribute value.
 * @returns Parsed boolean when the payload is recognizable.
 */
const parseSftpHiddenMarkerValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLocaleLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'hidden'].includes(normalized)) {
      return true;
    }

    if (['', '0', 'false', 'no', 'n', 'off', 'visible'].includes(normalized)) {
      return false;
    }

    return null;
  }

  if (value instanceof Uint8Array) {
    if (value.length === 0) {
      return false;
    }

    const decoded = Buffer.from(value).toString('utf8').replace(/\0/g, '').trim();
    const decodedMarker = parseSftpHiddenMarkerValue(decoded);
    if (decodedMarker !== null) {
      return decodedMarker;
    }

    if (value.length === 1) {
      return value[0] !== 0;
    }
  }

  if (isUnknownRecord(value)) {
    for (const markerKey of ['hidden', 'isHidden', 'is_hidden']) {
      if (markerKey in value) {
        return parseSftpHiddenMarkerValue(value[markerKey]);
      }
    }
  }

  return null;
};

/**
 * Resolves whether an SFTP entry should be treated as hidden.
 *
 * @param name Entry basename returned by the server.
 * @param stats SFTP stats object returned by ssh2.
 * @returns Whether the entry is hidden by server metadata or dot-prefix convention.
 */
export const resolveSftpEntryHiddenState = (name: string, stats: Stats): boolean => {
  const trimmedName = name.trim();
  if (trimmedName.startsWith('.') && trimmedName !== '.' && trimmedName !== '..') {
    return true;
  }

  const extended = (stats as SftpStatsWithExtendedAttributes).extended;
  if (!isUnknownRecord(extended)) {
    return false;
  }

  for (const [rawKey, rawValue] of Object.entries(extended)) {
    const normalizedKey = normalizeSftpExtendedAttributeName(rawKey);
    if (!HIDDEN_EXTENDED_ATTRIBUTE_NAMES.has(normalizedKey) && !normalizedKey.endsWith('hidden')) {
      continue;
    }

    const markerValue = parseSftpHiddenMarkerValue(rawValue);
    if (markerValue !== null) {
      return markerValue;
    }
  }

  return false;
};

/**
 * Preserves remote path bytes so the SFTP server resolves symbolic links and dot components.
 *
 * @param input Raw path input.
 * @returns Remote path, with only explicit Windows drive notation translated.
 */
export const normalizeSftpPathInput = (input: string | undefined): string => {
  if (!input) {
    return '.';
  }
  return /^[A-Za-z]:\\/.test(input) ? input.replace(/\\/g, '/') : input;
};

/**
 * Builds a child path without allowing platform-specific separators to leak into SFTP paths.
 *
 * @param parent Parent directory path.
 * @param name Entry name.
 * @returns Normalized child path.
 */
export const joinSftpPath = (parent: string, name: string): string => {
  return parent === '.' ? name : parent.replace(/\/+$/, '') + '/' + name;
};

/**
 * Returns a sibling path with a Finder-like numeric suffix when the target already exists.
 *
 * @param targetPath Desired destination path.
 * @param attempt Numbered collision attempt.
 * @returns Collision-resistant target path candidate.
 */
export const buildSftpCopyTargetCandidate = (targetPath: string, attempt: number): string => {
  if (attempt <= 0) {
    return targetPath;
  }

  const directoryName = POSIX_PATH.dirname(targetPath);
  const baseName = POSIX_PATH.basename(targetPath);
  const extensionName = POSIX_PATH.extname(baseName);
  const stem = extensionName ? baseName.slice(0, -extensionName.length) : baseName;
  const candidateName = `${stem} copy${attempt > 1 ? ` ${attempt}` : ''}${extensionName}`;

  return directoryName === '.' ? candidateName : joinSftpPath(directoryName, candidateName);
};

/**
 * Checks whether a normalized path is safe for mutating entry-level operations.
 *
 * @param targetPath Normalized SFTP path.
 * @returns True when the path targets a concrete entry instead of the root/current marker.
 */
export const isMutableSftpEntryPath = (targetPath: string): boolean => {
  const leaf = targetPath.replace(/\/+$/, '').split('/').at(-1);
  return Boolean(leaf && leaf !== '.' && leaf !== '..' && !targetPath.includes('\u0000'));
};

/**
 * Checks whether a local path stays inside the controlled SFTP temp root.
 *
 * @param candidatePath Absolute candidate path.
 * @param parentPath Absolute parent directory.
 * @returns Whether candidatePath is parentPath or one of its descendants.
 */
const isLocalPathInsideDirectory = (candidatePath: string, parentPath: string): boolean => {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === '' || (relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
};

/**
 * Asserts that the Main-owned SFTP temp root is private on POSIX platforms.
 *
 * @param rootPath Candidate root path used for diagnostics.
 * @param mode File mode from lstat.
 * @returns void.
 */
const assertPrivateSftpTemporaryRootMode = (rootPath: string, mode: number): void => {
  if (process.platform === 'win32') {
    return;
  }

  if ((mode & 0o077) !== 0) {
    throw new Error(`SFTP temporary root is not private: ${rootPath}`);
  }
};

/**
 * Validates the Main-owned SFTP temp root passed into Backend.
 *
 * @param configuredPath Path supplied by Main through constructor options or process env.
 * @returns Canonical temp root path.
 */
const validateConfiguredSftpTemporaryRootPath = (configuredPath: string | undefined): string => {
  const rootPath = configuredPath?.trim();
  if (!rootPath) {
    throw new Error(
      `${SFTP_TEMP_ROOT_ENV_NAME} is required for backend startup. Electron Main creates and injects this ` +
        'private SFTP temp root automatically. When starting @cosmosh/backend directly, create a real existing ' +
        `private directory and set ${SFTP_TEMP_ROOT_ENV_NAME} to its absolute path; POSIX platforms require mode 0700.`,
    );
  }

  const normalizedRootPath = path.resolve(rootPath);
  const rootStats = lstatSync(normalizedRootPath);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('SFTP temporary root must be a real directory.');
  }

  assertPrivateSftpTemporaryRootMode(normalizedRootPath, rootStats.mode);
  return realpathSync(normalizedRootPath);
};

/**
 * Maps ssh2 mode bits into the entry types shown by the SFTP browser.
 *
 * @param mode POSIX mode bits from ssh2 stats.
 * @returns SFTP entry type.
 */
export const resolveSftpEntryType = (mode: number): SftpEntryType => {
  const fileType = mode & S_IFMT;

  if (fileType === S_IFDIR) {
    return 'directory';
  }

  if (fileType === S_IFREG) {
    return 'file';
  }

  if (fileType === S_IFLNK) {
    return 'symlink';
  }

  return 'other';
};

/**
 * Formats POSIX mode bits into a compact permission string.
 *
 * @param mode POSIX mode bits from ssh2 stats.
 * @returns Symbolic permission string such as drwxr-xr-x.
 */
export const formatSftpPermissions = (mode: number): string => {
  const type = resolveSftpEntryType(mode);
  const prefix = type === 'directory' ? 'd' : type === 'symlink' ? 'l' : type === 'file' ? '-' : '?';
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const symbols = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  const permissions = bits.map((bit, index) => ((mode & bit) === bit ? symbols[index] : '-')).join('');

  return `${prefix}${permissions}`;
};

/**
 * Formats POSIX permission bits into the octal display used by chmod.
 *
 * @param mode POSIX mode bits from ssh2 stats.
 * @returns Four-digit octal permission string such as 0644.
 */
export const formatSftpPermissionOctal = (mode: number): string => {
  return (mode & 0o7777).toString(8).padStart(4, '0');
};

/**
 * Escapes a remote path for safe copy-paste into POSIX shells.
 *
 * @param targetPath Remote path.
 * @returns Single-quoted shell token.
 */
export const escapeSftpShellPath = (targetPath: string): string => {
  return quotePosixShellToken(targetPath);
};

/**
 * Manages SFTP file-system sessions created for renderer tabs.
 */
export class SftpSessionService {
  private readonly getDbClient: GetDbClient;

  private readonly auditEventService: AuditEventService;

  private readonly credentialEncryptionKey: Buffer;

  private readonly sftpTemporaryRootPath: string;

  private readonly sftpOperationIdleTimeoutMs: number;

  private readonly sftpOperationAbsoluteTimeoutMs: number;

  private readonly archiveService: SftpArchiveService;

  private readonly sessions = new Map<string, SftpLiveSession>();

  private readonly taskSchedulers = new Map<string, SftpTaskScheduler>();

  private readonly publicTaskRecords = new Map<string, Map<string, SftpPublicTaskRecord>>();

  private readonly transfers = new Map<string, SftpTransferRecord>();

  private readonly sessionOperationControllers = new WeakMap<SftpLiveSession, AbortController>();

  /**
   * Creates the backend-owned SFTP session service.
   *
   * @param options Database, audit, credential, temporary-path, and operation-lifecycle dependencies.
   */
  constructor(options: {
    getDbClient: GetDbClient;
    auditEventService: AuditEventService;
    credentialEncryptionKey: Buffer;
    sftpTemporaryRootPath?: string;
    sftpOperationIdleTimeoutMs?: number;
    sftpOperationAbsoluteTimeoutMs?: number;
  }) {
    const configuredOperationIdleTimeoutMs =
      options.sftpOperationIdleTimeoutMs ?? DEFAULT_SFTP_OPERATION_IDLE_TIMEOUT_MS;
    const configuredOperationAbsoluteTimeoutMs =
      options.sftpOperationAbsoluteTimeoutMs ?? DEFAULT_SFTP_OPERATION_ABSOLUTE_TIMEOUT_MS;
    if (!Number.isFinite(configuredOperationIdleTimeoutMs) || configuredOperationIdleTimeoutMs <= 0) {
      throw new RangeError('SFTP operation idle timeout must be a positive finite number.');
    }
    if (!Number.isFinite(configuredOperationAbsoluteTimeoutMs) || configuredOperationAbsoluteTimeoutMs <= 0) {
      throw new RangeError('SFTP operation absolute timeout must be a positive finite number.');
    }

    this.getDbClient = options.getDbClient;
    this.auditEventService = options.auditEventService;
    this.archiveService = new SftpArchiveService({
      auditEventService: options.auditEventService,
      operationTimeoutMs: configuredOperationAbsoluteTimeoutMs,
    });
    this.credentialEncryptionKey = options.credentialEncryptionKey;
    this.sftpOperationIdleTimeoutMs = configuredOperationIdleTimeoutMs;
    this.sftpOperationAbsoluteTimeoutMs = configuredOperationAbsoluteTimeoutMs;
    this.sftpTemporaryRootPath = validateConfiguredSftpTemporaryRootPath(
      options.sftpTemporaryRootPath ?? process.env[SFTP_TEMP_ROOT_ENV_NAME],
    );
  }

  /**
   * Opens one SSH connection and initializes the SFTP subsystem for directory browsing.
   *
   * @param input Session creation input from HTTP route.
   * @returns SFTP session creation result.
   */
  public async createSession(input: CreateSftpSessionInput): Promise<CreateSftpSessionResult> {
    const i18n = createI18n({ locale: input.locale, fallbackLocale: 'en' });
    const db = this.getDbClient();
    const initialPath = normalizeSftpPathInput(input.initialPath);
    const server = await db.sshServer.findUnique({
      where: {
        id: input.serverId,
      },
      include: {
        keychain: true,
      },
    });

    if (!server) {
      return { type: 'not-found' };
    }

    const trustedKeys = await db.sshKnownHost.findMany({
      where: {
        host: server.host,
        port: server.port,
        trusted: true,
        keyType: 'sha256',
      },
      select: {
        fingerprint: true,
      },
    });
    const trustedFingerprintSet = new Set(trustedKeys.map((item) => item.fingerprint));
    const strictHostKey = input.strictHostKey ?? server.strictHostKey;
    const enableSshCompression = server.enableSshCompression;
    const openResult = await this.openSftp(server, {
      connectTimeoutSec: input.connectTimeoutSec,
      strictHostKey,
      enableSshCompression,
      systemProxyRules: input.systemProxyRules,
      trustedFingerprintSet,
      t: i18n.t,
    });

    if (openResult.type === 'host-untrusted') {
      this.logSftpAuditEvent({
        category: 'sftp-session',
        action: 'connect',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId: input.requestId,
        metadata: {
          host: server.host,
          port: server.port,
          strictHostKey,
          enableSshCompression,
          fingerprint: openResult.fingerprint,
          reason: openResult.message || 'Host fingerprint is not trusted.',
          proxyMode: openResult.proxyMetadata?.mode,
          proxyProtocol: openResult.proxyMetadata?.protocol,
        },
      });

      return {
        type: 'host-untrusted',
        serverId: server.id,
        host: server.host,
        port: server.port,
        algorithm: 'sha256',
        fingerprint: openResult.fingerprint,
      };
    }

    if (openResult.type === 'failed') {
      this.logSftpAuditEvent({
        category: 'sftp-session',
        action: 'connect',
        outcome: 'failure',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId: input.requestId,
        metadata: {
          host: server.host,
          port: server.port,
          strictHostKey,
          enableSshCompression,
          reason: openResult.message,
          proxyMode: openResult.proxyMetadata?.mode,
          proxyProtocol: openResult.proxyMetadata?.protocol,
        },
      });

      return {
        type: 'failed',
        message: openResult.message,
      };
    }

    const sessionId = randomUUID();
    const session: SftpLiveSession = {
      sessionId,
      serverId: server.id,
      client: openResult.client,
      sftp: openResult.sftp,
      isClosed: false,
      t: i18n.t,
    };

    this.sessions.set(sessionId, session);
    this.watchSessionTransport(session);

    let resolvedInitialPath: string | null;
    try {
      resolvedInitialPath = await this.resolveRealPath(session, initialPath);
    } catch (error: unknown) {
      await this.closeSession(sessionId);
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, i18n.t('errors.sftp.directoryListFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }

    if (!resolvedInitialPath) {
      await this.closeSession(sessionId);
      return {
        type: 'failed',
        message: i18n.t('errors.sftp.directoryListFailedNoReason'),
      };
    }

    this.logSftpAuditEvent({
      category: 'sftp-session',
      action: 'connect',
      outcome: 'success',
      severity: 'info',
      entityType: 'ssh-server',
      entityId: server.id,
      sessionId,
      requestId: input.requestId,
      metadata: {
        host: server.host,
        port: server.port,
        strictHostKey,
        enableSshCompression,
        initialPath: resolvedInitialPath,
        proxyMode: openResult.proxyMetadata.mode,
        proxyProtocol: openResult.proxyMetadata.protocol,
      },
    });

    return {
      type: 'success',
      sessionId,
      serverId: server.id,
      initialPath: resolvedInitialPath,
      currentPath: resolvedInitialPath,
    };
  }

  /**
   * Lists entries for one active SFTP session directory.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote directory path.
   * @returns Directory list result.
   */
  public async listDirectory(sessionId: string, requestedPath: string | undefined): Promise<ListSftpDirectoryResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'list-directory',
      SFTP_READ_LIGHT_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.listDirectoryPrimitive(sessionId, requestedPath),
    );
  }

  /**
   * Lists one directory without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote directory path.
   * @returns Directory list result.
   */
  private async listDirectoryPrimitive(
    sessionId: string,
    requestedPath: string | undefined,
  ): Promise<ListSftpDirectoryResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    try {
      const resolvedPath = await this.resolveRealPath(session, normalizedPath);
      if (!resolvedPath) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.directoryListFailedNoReason'),
        };
      }

      const entries = await this.readdir(session, resolvedPath);
      const mappedEntries = await Promise.all(
        entries
          .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
          .map(async (entry) => {
            const entryPath = joinSftpPath(resolvedPath, entry.filename);
            const entryType = resolveSftpEntryType(entry.attrs.mode);
            const symlinkTarget =
              entryType === 'symlink' ? await this.resolveSymlinkTargetMetadata(session, entryPath) : undefined;

            return this.buildSftpEntry({
              name: entry.filename,
              path: entryPath,
              stats: entry.attrs,
              ...(entry.longname ? { longname: entry.longname } : {}),
              ...(symlinkTarget ? { symlinkTarget } : {}),
            });
          }),
      );

      return {
        type: 'success',
        sessionId,
        path: resolvedPath,
        parentPath: this.resolveParentPath(resolvedPath),
        entries: sortSftpEntriesByBrowserOrder(mappedEntries),
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.directoryListFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Fetches non-recursive metadata for selected remote entries.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPaths Remote entry paths selected by the renderer.
   * @returns Per-path metadata results without recursive directory size calculation.
   */
  public async getEntryDetails(sessionId: string, requestedPaths: string[]): Promise<GetSftpEntryDetailsResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'get-entry-details',
      SFTP_READ_LIGHT_RESOURCES,
      requestedPaths.length > 0 ? requestedPaths.map(normalizeSftpPathInput) : ['/'],
      async () => await this.getEntryDetailsPrimitive(sessionId, requestedPaths),
    );
  }

  /**
   * Reads selected entry metadata without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPaths Remote entry paths.
   * @returns Per-path metadata result.
   */
  private async getEntryDetailsPrimitive(
    sessionId: string,
    requestedPaths: string[],
  ): Promise<GetSftpEntryDetailsResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const entries: SftpEntryDetailsItem[] = [];
    for (const requestedPath of requestedPaths) {
      const normalizedPath = normalizeSftpPathInput(requestedPath);
      if (!isMutableSftpEntryPath(normalizedPath)) {
        entries.push({
          path: normalizedPath,
          status: 'failed',
          message: session.t('errors.sftp.pathRequired'),
        });
        continue;
      }

      entries.push(await this.getSingleEntryDetails(session, normalizedPath));
    }

    return {
      type: 'success',
      sessionId,
      requestedCount: requestedPaths.length,
      entries,
    };
  }

  /**
   * Reads one remote file into a bounded UTF-8 preview payload.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param requestedMaxBytes Maximum preview bytes requested by the caller.
   * @returns File preview result.
   */
  public async readFilePreview(
    sessionId: string,
    requestedPath: string | undefined,
    requestedMaxBytes?: number,
  ): Promise<ReadSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'read-file',
      SFTP_READ_LIGHT_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.readFilePreviewPrimitive(sessionId, requestedPath, requestedMaxBytes),
    );
  }

  /**
   * Reads one preview without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param requestedMaxBytes Maximum preview bytes.
   * @returns File preview result.
   */
  private async readFilePreviewPrimitive(
    sessionId: string,
    requestedPath: string | undefined,
    requestedMaxBytes?: number,
  ): Promise<ReadSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    try {
      const stats = await this.stat(session, normalizedPath);
      if (!stats.isFile()) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.fileReadUnsupported'),
        };
      }

      const maxBytes = this.normalizeReadFileMaxBytes(requestedMaxBytes);
      const readLength = Math.min(stats.size, maxBytes);
      const buffer = Buffer.alloc(readLength);
      const handle = await this.open(session, normalizedPath, 'r');
      let bytesReadTotal = 0;

      try {
        if (readLength > 0) {
          bytesReadTotal = await this.readFullyIntoBuffer(session, handle, buffer, readLength);
        }
      } finally {
        await this.closeHandle(session, handle).catch(() => undefined);
      }

      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
        content: buffer.subarray(0, bytesReadTotal).toString('utf8'),
        size: stats.size,
        truncated: stats.size > maxBytes,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.fileReadFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Writes UTF-8 text content back to one regular remote file.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param content UTF-8 text content to write.
   * @param expectedRemoteSnapshot Remote metadata captured when the preview was opened.
   * @param options Conflict override options.
   * @returns Write result with updated remote metadata.
   */
  public async writeTextFile(
    sessionId: string,
    requestedPath: string | undefined,
    content: string,
    expectedRemoteSnapshot: UploadSftpFileConflictSnapshot,
    options: UploadSftpFileOptions = {},
  ): Promise<WriteSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'write-file',
      SFTP_MUTATION_HEAVY_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.writeTextFilePrimitive(sessionId, requestedPath, content, expectedRemoteSnapshot, options),
    );
  }

  /**
   * Writes preview content without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param content UTF-8 file content.
   * @param expectedRemoteSnapshot Previously observed remote metadata.
   * @param options Conflict override options.
   * @returns Write result.
   */
  private async writeTextFilePrimitive(
    sessionId: string,
    requestedPath: string | undefined,
    content: string,
    expectedRemoteSnapshot: UploadSftpFileConflictSnapshot,
    options: UploadSftpFileOptions = {},
  ): Promise<WriteSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    const contentBuffer = Buffer.from(content, 'utf8');
    if (contentBuffer.byteLength > MAX_WRITE_FILE_CONTENT_BYTES) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.fileWriteTooLarge', {
          limit: MAX_WRITE_FILE_CONTENT_BYTES,
        }),
      };
    }

    try {
      const targetStats = await this.stat(session, normalizedPath);
      if (!targetStats.isFile()) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.fileUploadUnsupported'),
        };
      }

      if (!options.overwrite && !this.doesRemoteSnapshotMatch(targetStats, expectedRemoteSnapshot)) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.fileUploadRemoteChanged'),
          reason: 'remote-conflict',
        };
      }

      await this.writeBufferToRemotePath(session, contentBuffer, normalizedPath, targetStats.mode & 0o777, {
        expectedRemoteSnapshot: options.overwrite ? undefined : expectedRemoteSnapshot,
      });
      this.logSftpMutation(session, 'write-file', {
        path: normalizedPath,
      });

      const writtenStats = await this.stat(session, normalizedPath);
      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
        size: writtenStats.size,
        modifiedAt: this.formatStatsTimestamp(writtenStats.mtime),
      };
    } catch (error: unknown) {
      if (error instanceof SftpRemoteConflictError) {
        return {
          type: 'failed',
          message: error.message,
          reason: 'remote-conflict',
        };
      }

      return {
        type: 'failed',
        message: this.resolveUploadErrorMessage(error, session.t('errors.sftp.fileWriteFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Downloads one regular remote file into a local workstation path.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param localPath Absolute local destination path selected by the main process.
   * @returns Download result with final local path and byte size.
   */
  public async downloadFile(
    sessionId: string,
    requestedPath: string | undefined,
    localPath: string | undefined,
    transferId?: string,
  ): Promise<DownloadSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'download',
      SFTP_READ_HEAVY_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.downloadFilePrimitive(sessionId, requestedPath, localPath, transferId),
    );
  }

  /**
   * Downloads one file without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param localPath Authorized local destination.
   * @param transferId Optional transfer progress id.
   * @returns Download result.
   */
  private async downloadFilePrimitive(
    sessionId: string,
    requestedPath: string | undefined,
    localPath: string | undefined,
    transferId?: string,
  ): Promise<DownloadSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    const normalizedLocalPath = localPath?.trim();
    if (!normalizedLocalPath) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.localPathRequired'),
      };
    }

    try {
      const sourceStats = await this.stat(session, normalizedPath);
      if (!sourceStats.isFile()) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.fileReadUnsupported'),
        };
      }

      this.beginTransfer(transferId, 'download', sourceStats.size);
      await this.downloadFileToLocalPath(session, normalizedPath, normalizedLocalPath, transferId);
      this.completeTransfer(transferId);

      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
        localPath: normalizedLocalPath,
        size: sourceStats.size,
      };
    } catch (error: unknown) {
      const message = this.resolveErrorMessage(error, session.t('errors.sftp.fileDownloadFailedNoReason'));
      this.failTransfer(transferId, message);
      if (isSftpOperationFailure(error)) {
        return {
          type: 'failed',
          message,
          ...this.resolveOperationFailureMetadata(error),
        };
      }

      return {
        type: 'failed',
        message,
      };
    }
  }

  /**
   * Uploads one controlled local temp file to a new or existing remote path.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param localPath Absolute local temp path selected by the main process.
   * @param expectedRemoteSnapshot Optional metadata captured when an existing remote file was opened.
   * @returns Upload result.
   */
  public async uploadFile(
    sessionId: string,
    requestedPath: string | undefined,
    localPath: string | undefined,
    expectedRemoteSnapshot?: UploadSftpFileConflictSnapshot,
    options: UploadSftpFileOptions = {},
  ): Promise<UploadSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'upload',
      SFTP_MUTATION_HEAVY_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.uploadFilePrimitive(sessionId, requestedPath, localPath, expectedRemoteSnapshot, options),
    );
  }

  /**
   * Uploads one file without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @param localPath Authorized local source.
   * @param expectedRemoteSnapshot Optional previously observed remote metadata.
   * @param options Conflict and transfer options.
   * @returns Upload result.
   */
  private async uploadFilePrimitive(
    sessionId: string,
    requestedPath: string | undefined,
    localPath: string | undefined,
    expectedRemoteSnapshot?: UploadSftpFileConflictSnapshot,
    options: UploadSftpFileOptions = {},
  ): Promise<UploadSftpFileResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    const requestedLocalPath = localPath?.trim() ?? '';
    if (!requestedLocalPath) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.localPathRequired'),
      };
    }

    const normalizedLocalPath = path.resolve(requestedLocalPath);
    if (!isLocalPathInsideDirectory(normalizedLocalPath, this.sftpTemporaryRootPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.localFileReadUnsupported'),
      };
    }

    try {
      let targetStats: Stats | undefined;
      try {
        targetStats = await this.stat(session, normalizedPath);
      } catch (error: unknown) {
        if (!this.isNoSuchFileError(error)) {
          throw error;
        }
      }

      if (targetStats) {
        if (!targetStats.isFile()) {
          return {
            type: 'failed',
            message: session.t('errors.sftp.fileUploadUnsupported'),
          };
        }

        if (!options.overwrite) {
          if (!expectedRemoteSnapshot) {
            return {
              type: 'failed',
              message: session.t('errors.sftp.fileUploadTargetExists'),
              reason: 'remote-conflict',
            };
          }

          if (!this.doesRemoteSnapshotMatch(targetStats, expectedRemoteSnapshot)) {
            return {
              type: 'failed',
              message: session.t('errors.sftp.fileUploadRemoteChanged'),
              reason: 'remote-conflict',
            };
          }
        }
      } else if (expectedRemoteSnapshot && !options.overwrite) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.fileUploadRemoteChanged'),
          reason: 'remote-conflict',
        };
      }

      const canonicalLocalPath = await this.resolveExistingUploadLocalPath(normalizedLocalPath);
      if (!canonicalLocalPath) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.localFileReadUnsupported'),
        };
      }

      const localStats = await fs.lstat(canonicalLocalPath);
      if (!localStats.isFile() || localStats.isSymbolicLink()) {
        return {
          type: 'failed',
          message: session.t('errors.sftp.localFileReadUnsupported'),
        };
      }

      this.beginTransfer(options.transferId, 'upload', localStats.size);
      if (targetStats) {
        await this.uploadLocalFileToRemotePath(
          session,
          canonicalLocalPath,
          normalizedPath,
          targetStats.mode & 0o777,
          {
            expectedRemoteSnapshot: options.overwrite ? undefined : expectedRemoteSnapshot,
          },
          options.transferId,
        );
      } else {
        await this.createRemoteFileFromLocalPath(
          session,
          canonicalLocalPath,
          normalizedPath,
          0o644,
          options.transferId,
        );
      }

      this.logSftpMutation(session, 'upload', {
        path: normalizedPath,
      });
      const uploadedStats = await this.stat(session, normalizedPath);
      this.completeTransfer(options.transferId);

      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
        size: uploadedStats.size,
        modifiedAt: this.formatStatsTimestamp(uploadedStats.mtime),
      };
    } catch (error: unknown) {
      const message = this.resolveUploadErrorMessage(error, session.t('errors.sftp.fileUploadFailedNoReason'));
      this.failTransfer(options.transferId, message);
      if (error instanceof SftpRemoteConflictError) {
        return {
          type: 'failed',
          message: error.message,
          reason: 'remote-conflict',
        };
      }

      if (isSftpOperationFailure(error)) {
        return {
          type: 'failed',
          message,
          ...this.resolveOperationFailureMetadata(error),
        };
      }

      return {
        type: 'failed',
        message,
      };
    }
  }

  /**
   * Reads one active or recently completed transfer progress snapshot.
   *
   * @param transferId Renderer-generated transfer identifier.
   * @returns Progress snapshot, or null after the record expires.
   */
  public getTransferProgress(transferId: string): SftpTransferProgress | null {
    this.pruneExpiredTransfers();
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return null;
    }

    return {
      transferId: transfer.transferId,
      direction: transfer.direction,
      status: transfer.status,
      transferredBytes: transfer.transferredBytes,
      totalBytes: transfer.totalBytes,
      bytesPerSecond: transfer.bytesPerSecond,
      startedAt: new Date(transfer.startedAt).toISOString(),
      updatedAt: new Date(transfer.updatedAt).toISOString(),
      ...(transfer.finishedAt ? { finishedAt: new Date(transfer.finishedAt).toISOString() } : {}),
      ...(transfer.errorMessage ? { errorMessage: transfer.errorMessage } : {}),
    };
  }

  /**
   * Creates one empty remote file.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @returns File creation result.
   */
  public async createFile(sessionId: string, requestedPath: string | undefined): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'create-file',
      SFTP_MUTATION_LIGHT_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.createFilePrimitive(sessionId, requestedPath),
    );
  }

  /**
   * Creates one file without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote file path.
   * @returns File creation result.
   */
  private async createFilePrimitive(
    sessionId: string,
    requestedPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    try {
      await this.writeFile(session, normalizedPath, Buffer.alloc(0), DEFAULT_FILE_MODE);
      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.fileCreateFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Creates one remote directory.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote directory path.
   * @returns Directory creation result.
   */
  public async createDirectory(sessionId: string, requestedPath: string | undefined): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'create-directory',
      SFTP_MUTATION_LIGHT_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.createDirectoryPrimitive(sessionId, requestedPath),
    );
  }

  /**
   * Creates one directory without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote directory path.
   * @returns Directory creation result.
   */
  private async createDirectoryPrimitive(
    sessionId: string,
    requestedPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    try {
      await this.mkdir(session, normalizedPath, DEFAULT_DIRECTORY_MODE);
      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.directoryCreateFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Renames or moves one remote entry.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedSourcePath Source path.
   * @param requestedTargetPath Target path.
   * @returns Rename result.
   */
  public async renameEntry(
    sessionId: string,
    requestedSourcePath: string | undefined,
    requestedTargetPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'rename',
      SFTP_MUTATION_LIGHT_RESOURCES,
      [normalizeSftpPathInput(requestedSourcePath), normalizeSftpPathInput(requestedTargetPath)],
      async () => await this.renameEntryPrimitive(sessionId, requestedSourcePath, requestedTargetPath),
    );
  }

  /**
   * Renames one entry without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedSourcePath Existing remote path.
   * @param requestedTargetPath Desired remote path.
   * @returns Rename result.
   */
  private async renameEntryPrimitive(
    sessionId: string,
    requestedSourcePath: string | undefined,
    requestedTargetPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const sourcePath = normalizeSftpPathInput(requestedSourcePath);
    const targetPath = normalizeSftpPathInput(requestedTargetPath);
    if (!isMutableSftpEntryPath(sourcePath) || !isMutableSftpEntryPath(targetPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    if (sourcePath === targetPath) {
      return {
        type: 'success',
        sessionId,
        path: sourcePath,
        targetPath,
      };
    }

    try {
      const sourceStats = await this.lstat(session, sourcePath);
      if (sourceStats.isDirectory() && this.isSameOrDescendantPath(sourcePath, targetPath)) {
        throw new Error(session.t('errors.sftp.moveIntoSelfUnsupported'));
      }

      await this.rename(session, sourcePath, targetPath);
      this.logSftpMutation(session, 'rename', {
        path: sourcePath,
        targetPath,
      });
      return {
        type: 'success',
        sessionId,
        path: sourcePath,
        targetPath,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.entryRenameFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Copies one remote file or directory tree.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedSourcePath Source path.
   * @param requestedTargetPath Target path.
   * @returns Copy result.
   */
  public async copyEntry(
    sessionId: string,
    requestedSourcePath: string | undefined,
    requestedTargetPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedTargetPath = normalizeSftpPathInput(requestedTargetPath);
    return await this.runCoordinatedSftpOperation(
      session,
      'copy',
      SFTP_MUTATION_HEAVY_RESOURCES,
      [normalizeSftpPathInput(requestedSourcePath), POSIX_PATH.dirname(normalizedTargetPath)],
      async () => await this.copyEntryPrimitive(sessionId, requestedSourcePath, requestedTargetPath),
    );
  }

  /**
   * Copies one entry without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedSourcePath Existing remote path.
   * @param requestedTargetPath Desired remote path.
   * @returns Copy result.
   */
  private async copyEntryPrimitive(
    sessionId: string,
    requestedSourcePath: string | undefined,
    requestedTargetPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const sourcePath = normalizeSftpPathInput(requestedSourcePath);
    const targetPath = normalizeSftpPathInput(requestedTargetPath);
    if (!isMutableSftpEntryPath(sourcePath) || !isMutableSftpEntryPath(targetPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    try {
      const resolvedTargetPath = await this.resolveAvailableCopyPath(session, targetPath);
      const [sourceIdentity, targetParentIdentity] = await Promise.all([
        this.resolveRealPath(session, sourcePath),
        this.resolveRealPath(session, POSIX_PATH.dirname(resolvedTargetPath)),
      ]);
      if (!sourceIdentity || !targetParentIdentity) {
        throw new Error(session.t('errors.sftp.entryCopyFailedNoReason'));
      }
      if (
        this.isSameOrDescendantPath(
          sourceIdentity,
          joinSftpPath(targetParentIdentity, POSIX_PATH.basename(resolvedTargetPath)),
        )
      ) {
        throw new Error(session.t('errors.sftp.copyIntoSelfUnsupported'));
      }

      await this.copyEntryRecursive(session, sourcePath, resolvedTargetPath);
      this.logSftpMutation(session, 'copy', {
        path: sourcePath,
        targetPath: resolvedTargetPath,
      });

      return {
        type: 'success',
        sessionId,
        path: sourcePath,
        targetPath: resolvedTargetPath,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.entryCopyFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Creates one absolute symbolic link to a remote file or directory.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedSourcePath Source path the link should point to.
   * @param requestedTargetPath Desired link path.
   * @returns Link result.
   */
  private async linkEntryPrimitive(
    sessionId: string,
    requestedSourcePath: string | undefined,
    requestedTargetPath: string | undefined,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const sourcePath = normalizeSftpPathInput(requestedSourcePath);
    const targetPath = normalizeSftpPathInput(requestedTargetPath);
    if (!isMutableSftpEntryPath(sourcePath) || !isMutableSftpEntryPath(targetPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    try {
      const resolvedTargetPath = await this.resolveAvailableCopyPath(session, targetPath);
      await this.symlink(session, sourcePath, resolvedTargetPath);
      this.logSftpMutation(session, 'link', {
        path: sourcePath,
        targetPath: resolvedTargetPath,
      });

      return {
        type: 'success',
        sessionId,
        path: sourcePath,
        targetPath: resolvedTargetPath,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.entryLinkFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Deletes one remote file, symlink, or directory tree.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote entry path.
   * @param recursive Whether directories should be removed recursively.
   * @returns Delete result.
   */
  public async deleteEntry(
    sessionId: string,
    requestedPath: string | undefined,
    recursive: boolean,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'delete',
      recursive ? SFTP_MUTATION_HEAVY_RESOURCES : SFTP_MUTATION_LIGHT_RESOURCES,
      [normalizeSftpPathInput(requestedPath)],
      async () => await this.deleteEntryPrimitive(sessionId, requestedPath, recursive),
    );
  }

  /**
   * Deletes one entry without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param requestedPath Remote entry path.
   * @param recursive Whether directory descendants should be removed.
   * @returns Delete result.
   */
  private async deleteEntryPrimitive(
    sessionId: string,
    requestedPath: string | undefined,
    recursive: boolean,
  ): Promise<SftpOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const normalizedPath = normalizeSftpPathInput(requestedPath);
    if (!isMutableSftpEntryPath(normalizedPath)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    try {
      await this.deleteEntryRecursive(session, normalizedPath, recursive);
      this.logSftpMutation(session, 'delete', {
        path: normalizedPath,
        recursive,
      });
      return {
        type: 'success',
        sessionId,
        path: normalizedPath,
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.entryDeleteFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Runs one ordered, fail-fast batch operation against one active SFTP session.
   *
   * @param sessionId Live SFTP session id.
   * @param input Normalized batch operation input from the HTTP route.
   * @returns Batch execution summary with per-entry status.
   */
  public async runBatchOperation(
    sessionId: string,
    input: RunSftpBatchOperationInput,
  ): Promise<SftpBatchOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    return await this.runCoordinatedSftpOperation(
      session,
      'batch',
      SFTP_MUTATION_HEAVY_RESOURCES,
      [
        ...input.entries.map((entry) => normalizeSftpPathInput(entry.path)),
        ...(input.targetDirectoryPath ? [normalizeSftpPathInput(input.targetDirectoryPath)] : []),
      ],
      async () => await this.runBatchOperationPrimitive(sessionId, input),
    );
  }

  /**
   * Runs one batch without acquiring another scheduler slot.
   *
   * @param sessionId Live SFTP session id.
   * @param input Normalized ordered batch request.
   * @returns Batch execution summary.
   */
  private async runBatchOperationPrimitive(
    sessionId: string,
    input: RunSftpBatchOperationInput,
  ): Promise<SftpBatchOperationResult> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    if (input.entries.length === 0) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.batchEntriesRequired'),
      };
    }

    const targetDirectoryPath = input.targetDirectoryPath
      ? normalizeSftpPathInput(input.targetDirectoryPath)
      : undefined;
    if (
      (input.operation === 'copy' || input.operation === 'move' || input.operation === 'link') &&
      !targetDirectoryPath
    ) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.batchTargetRequired'),
      };
    }

    const entries = input.entries.map((entry) => ({
      path: normalizeSftpPathInput(entry.path),
      type: entry.type,
    }));

    if (entries.some((entry) => !isMutableSftpEntryPath(entry.path))) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.pathRequired'),
      };
    }

    const results: SftpBatchOperationItemResult[] = [];
    let stoppedOnFailure = false;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const result = await this.runSingleBatchEntryOperation(sessionId, input.operation, entry, targetDirectoryPath);

      if (result.type === 'success') {
        const itemResult: SftpBatchOperationItemResult = {
          path: result.path,
          type: entry.type,
          status: 'success',
        };

        if (result.targetPath) {
          itemResult.targetPath = result.targetPath;
        }

        results.push(itemResult);
        continue;
      }

      const message = result.type === 'not-found' ? session.t('errors.sftp.sessionNotFound') : result.message;
      results.push({
        path: entry.path,
        type: entry.type,
        status: 'failed',
        message,
        ...(result.type === 'failed' && result.operationErrorCode
          ? {
              operationErrorCode: result.operationErrorCode,
              ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
            }
          : {}),
      });
      stoppedOnFailure = true;

      for (const skippedEntry of entries.slice(index + 1)) {
        results.push({
          path: skippedEntry.path,
          type: skippedEntry.type,
          status: 'skipped',
          message: session.t('errors.sftp.batchSkippedAfterFailure'),
        });
      }
      break;
    }

    const completedCount = results.filter((result) => result.status === 'success').length;
    const failedCount = results.filter((result) => result.status === 'failed').length;
    const skippedCount = results.filter((result) => result.status === 'skipped').length;

    return {
      type: 'success',
      sessionId,
      operation: input.operation,
      totalCount: entries.length,
      completedCount,
      failedCount,
      skippedCount,
      stoppedOnFailure,
      results,
    };
  }

  /**
   * Accepts one bounded asynchronous task for the requested live SFTP session.
   *
   * Existing operation methods remain the unscheduled execution primitives so a batch task never
   * waits on a nested mutation slot that it already owns.
   *
   * @param sessionId Live SFTP session id.
   * @param request Validated task descriptor.
   * @returns Accepted task snapshot, missing-session result, or validation failure.
   */
  public startTask(sessionId: string, request: ApiSftpStartTaskRequest): StartSftpTaskResult {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return { type: 'not-found' };
    }

    const records = this.getOrCreatePublicTaskRecords(sessionId);
    if (!this.makeRoomForPublicTask(sessionId, records)) {
      return {
        type: 'failed',
        message: session.t('errors.sftp.taskQueueFull', {
          limit: SFTP_TASK_RECORD_LIMIT_PER_SESSION,
        }),
      };
    }

    const scheduler = this.getOrCreateTaskScheduler(sessionId);
    const resources = this.resolveTaskResources(request);
    const remotePaths = this.resolveTaskRemotePaths(request);
    const transferId =
      request.operation === 'upload' || request.operation === 'download' ? request.payload.transferId : undefined;

    try {
      const handle = scheduler.schedule<ApiSftpTaskResult, ApiSftpTaskResult>({
        operation: request.operation,
        resources,
        claims: remotePaths,
        absoluteTimeoutMs: this.sftpOperationAbsoluteTimeoutMs,
        run: async () => await this.executeTaskRequest(sessionId, request, session.t),
        mapFailure: (error) => ({
          code: API_CODES.sftpOperationFailed,
          message: this.resolveErrorMessage(error, session.t('errors.sftp.operationFailedNoReason')),
          ...(resources.impact === 'mutation' ? { outcomeUnknown: true } : {}),
        }),
        onAbort: (reason) => {
          if (reason === 'deadline') {
            this.poisonUnusableSession(session);
          } else {
            this.markSessionUnavailable(session);
          }
        },
      });
      const record: SftpPublicTaskRecord = {
        operation: request.operation,
        remotePaths: [...handle.getSnapshot().claims],
        handle,
        released: false,
        ...(transferId ? { transferId } : {}),
      };
      records.set(handle.taskId, record);
      void handle.released.then(() => {
        record.released = true;
        this.armPublicTaskRetention(sessionId, handle.taskId, record);
      });
      return {
        type: 'success',
        task: this.toApiTaskData(record, handle.getSnapshot()),
      };
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.operationFailedNoReason')),
      };
    }
  }

  /**
   * Lists public asynchronous tasks retained for one current or recently closed session.
   *
   * @param sessionId Owning SFTP session id.
   * @returns Tasks in creation order, or null when the session has never existed in this runtime.
   */
  public listTasks(sessionId: string): ApiSftpTaskData[] | null {
    const records = this.publicTaskRecords.get(sessionId);
    if (!records) {
      return this.getOpenSession(sessionId) ? [] : null;
    }

    return [...records.values()].map((record) => this.toApiTaskData(record, record.handle.getSnapshot()));
  }

  /**
   * Reads one retained public asynchronous task without requiring a live transport.
   *
   * @param sessionId Owning SFTP session id.
   * @param taskId Retained task id.
   * @returns Latest task snapshot or null when the task is unknown.
   */
  public getTask(sessionId: string, taskId: string): ApiSftpTaskData | null {
    const record = this.publicTaskRecords.get(sessionId)?.get(taskId);
    return record ? this.toApiTaskData(record, record.handle.getSnapshot()) : null;
  }

  /**
   * Returns remote archive capabilities for one active SFTP session.
   *
   * @param sessionId Live SFTP session id.
   * @returns Capability payload, or null when the session is unavailable.
   */
  public async getArchiveCapabilities(sessionId: string): Promise<ApiSftpArchiveCapabilitiesData | null> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return null;
    }

    const scheduler = this.getOrCreateTaskScheduler(sessionId);
    const admissionController = new AbortController();
    const scheduled = scheduler.schedule<ApiSftpArchiveCapabilitiesData>({
      operation: 'archive-capabilities',
      resources: SFTP_ARCHIVE_EXCLUSIVE_RESOURCES,
      claims: ['/'],
      absoluteTimeoutMs: this.sftpOperationAbsoluteTimeoutMs,
      cancellationSignal: admissionController.signal,
      run: async () => ({
        state: 'succeeded',
        result: await this.archiveService.getCapabilities(session),
      }),
      mapFailure: (error) => ({
        code: API_CODES.sftpArchiveOperationFailed,
        message: this.resolveErrorMessage(error, session.t('errors.sftp.archiveOperationFailed')),
      }),
      onAbort: (reason) => {
        if (reason === 'deadline') {
          this.poisonUnusableSession(session);
        }
      },
    });
    void scheduled.released.then(() => {
      scheduler.forgetTask(scheduled.taskId);
      this.deleteClosedTaskSchedulerIfUnused(sessionId);
    });
    if (scheduled.getSnapshot().state === 'queued') {
      admissionController.abort();
      throw new SftpArchiveError(API_CODES.sftpArchiveBusy, 'Another SFTP operation is active for this session.');
    }

    const snapshot = await scheduled.completion;
    if (snapshot.state === 'succeeded' && snapshot.result) {
      return snapshot.result;
    }
    throw new SftpArchiveError(
      API_CODES.sftpArchiveOperationFailed,
      snapshot.failure?.message ?? session.t('errors.sftp.archiveOperationFailed'),
    );
  }

  /**
   * Starts one structured remote archive operation.
   *
   * @param sessionId Live SFTP session id.
   * @param request Validated archive request.
   * @returns Initial operation state, or null when the session is unavailable.
   */
  public async startArchiveOperation(
    sessionId: string,
    request: ApiSftpArchiveOperationRequest,
  ): Promise<ApiSftpArchiveOperationData | null> {
    const session = this.getOpenSession(sessionId);
    if (!session) {
      return null;
    }

    const scheduler = this.getOrCreateTaskScheduler(sessionId);
    const admissionController = new AbortController();
    let operationId: string | undefined;
    let acceptedSettled = false;
    let resolveAccepted: (operation: ApiSftpArchiveOperationData) => void = () => undefined;
    let rejectAccepted: (error: unknown) => void = () => undefined;
    const accepted = new Promise<ApiSftpArchiveOperationData>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const settleAccepted = (operation: ApiSftpArchiveOperationData): void => {
      if (acceptedSettled) {
        return;
      }
      acceptedSettled = true;
      resolveAccepted(operation);
    };
    const settleRejected = (error: unknown): void => {
      if (acceptedSettled) {
        return;
      }
      acceptedSettled = true;
      rejectAccepted(error);
    };

    const scheduled = scheduler.schedule<ApiSftpArchiveOperationData>({
      operation: 'archive',
      resources: SFTP_ARCHIVE_EXCLUSIVE_RESOURCES,
      claims: ['/'],
      absoluteTimeoutMs: this.sftpOperationAbsoluteTimeoutMs,
      cancellationSignal: admissionController.signal,
      run: async (context) => {
        try {
          const operation = await this.archiveService.startOperation(session, request, context.deadlineAt);
          operationId = operation.operationId;
          settleAccepted(operation);
          const terminal = await this.archiveService.waitForOperation(sessionId, operation.operationId);
          if (terminal.state === 'succeeded') {
            return {
              state: 'succeeded',
              result: terminal,
            };
          }
          if (terminal.state === 'cancelled') {
            return {
              state: 'cancelled',
              result: terminal,
            };
          }
          return {
            state: 'failed',
            result: terminal,
            failure: {
              code: terminal.errorCode ?? API_CODES.sftpArchiveOperationFailed,
              message: terminal.errorMessage ?? session.t('errors.sftp.archiveOperationFailed'),
            },
          };
        } catch (error: unknown) {
          settleRejected(error);
          throw error;
        }
      },
      mapFailure: (error) => ({
        code: error instanceof SftpArchiveError ? error.code : API_CODES.sftpArchiveOperationFailed,
        message: this.resolveErrorMessage(error, session.t('errors.sftp.archiveOperationFailed')),
      }),
      onAbort: (reason) => {
        if (operationId) {
          try {
            if (reason === 'deadline') {
              this.archiveService.timeoutOperation(sessionId, operationId);
            } else {
              this.archiveService.cancelOperation(sessionId, operationId);
            }
          } catch (error: unknown) {
            console.warn('[sftp:archive] Failed to stop a scheduler-owned archive operation.', error);
          }
        }
        if (reason === 'deadline') {
          this.poisonUnusableSession(session);
        }
      },
    });
    void scheduled.released.then(() => {
      scheduler.forgetTask(scheduled.taskId);
      this.deleteClosedTaskSchedulerIfUnused(sessionId);
    });
    if (scheduled.getSnapshot().state === 'queued') {
      admissionController.abort();
      throw new SftpArchiveError(API_CODES.sftpArchiveBusy, 'Another SFTP operation is active for this session.');
    }
    void scheduled.completion.then((snapshot) => {
      if (acceptedSettled) {
        return;
      }
      const timedOut = snapshot.failure?.code === API_CODES.sftpTaskDeadlineExceeded;
      settleRejected(
        new SftpArchiveError(
          timedOut ? API_CODES.sftpArchiveTimeout : API_CODES.sftpArchiveOperationFailed,
          snapshot.failure?.message ?? session.t('errors.sftp.archiveOperationFailed'),
        ),
      );
    });
    return await accepted;
  }

  /**
   * Reads a retained archive operation for one active session.
   *
   * @param sessionId Live SFTP session id.
   * @param operationId Archive operation id.
   * @returns Public archive operation state, or null when the session is unavailable.
   */
  public getArchiveOperation(sessionId: string, operationId: string): ApiSftpArchiveOperationData | null {
    return this.archiveService.getOperation(sessionId, operationId);
  }

  /**
   * Resolves all pending conflicts for one archive operation.
   *
   * @param sessionId Live SFTP session id.
   * @param operationId Archive operation id.
   * @param resolution Decision applied to the operation.
   * @returns Updated operation state, or null when the session is unavailable.
   */
  public resolveArchiveConflict(
    sessionId: string,
    operationId: string,
    resolution: ApiSftpArchiveConflictResolution,
  ): ApiSftpArchiveOperationData | null {
    return this.archiveService.resolveConflict(sessionId, operationId, resolution);
  }

  /**
   * Requests cancellation of one archive operation.
   *
   * @param sessionId Live SFTP session id.
   * @param operationId Archive operation id.
   * @returns Updated operation state, or null when the session is unavailable.
   */
  public cancelArchiveOperation(sessionId: string, operationId: string): ApiSftpArchiveOperationData | null {
    return this.archiveService.cancelOperation(sessionId, operationId);
  }

  /**
   * Returns or creates the scheduler that owns one session's complete task history.
   *
   * @param sessionId Owning SFTP session id.
   * @returns Session-scoped scheduler.
   */
  private getOrCreateTaskScheduler(sessionId: string): SftpTaskScheduler {
    const existing = this.taskSchedulers.get(sessionId);
    if (existing) {
      return existing;
    }

    const scheduler = new SftpTaskScheduler({ sessionId });
    this.taskSchedulers.set(sessionId, scheduler);
    return scheduler;
  }

  /**
   * Releases an idle scheduler after its closed session no longer owns retained task records.
   *
   * @param sessionId Closed session whose scheduler may no longer be observable.
   * @returns void.
   */
  private deleteClosedTaskSchedulerIfUnused(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      return;
    }

    const publicRecords = this.publicTaskRecords.get(sessionId);
    if (publicRecords && publicRecords.size > 0) {
      return;
    }

    const scheduler = this.taskSchedulers.get(sessionId);
    if (scheduler && scheduler.listTasks().length > 0) {
      return;
    }

    this.publicTaskRecords.delete(sessionId);
    this.taskSchedulers.delete(sessionId);
  }

  /**
   * Runs one legacy request through the same scheduler used by asynchronous tasks.
   *
   * The runner returns the existing result union as data so validation and remote failures retain
   * their established HTTP behavior. Scheduler-owned deadline and close cancellation failures are
   * translated back into the operation metadata introduced by the guarded SFTP boundary.
   *
   * @template TResult Existing operation result union.
   * @param session Open session captured before admission.
   * @param operation Stable diagnostic operation name.
   * @param resources Capacity and mutation profile.
   * @param claims Remote paths reserved for the complete operation.
   * @param run Unscheduled operation primitive.
   * @returns Existing operation result after scheduler admission and execution.
   */
  private async runCoordinatedSftpOperation<TResult extends CoordinatedSftpOperationResult>(
    session: SftpLiveSession,
    operation: string,
    resources: SftpTaskResources,
    claims: readonly string[],
    run: () => Promise<TResult>,
  ): Promise<TResult> {
    const scheduler = this.getOrCreateTaskScheduler(session.sessionId);
    const handle = scheduler.schedule<TResult>({
      operation: `legacy-${operation}`,
      resources,
      claims,
      absoluteTimeoutMs: this.sftpOperationAbsoluteTimeoutMs,
      run: async () => ({
        state: 'succeeded',
        result: await run(),
      }),
      mapFailure: (error) => {
        if (isSftpOperationFailure(error)) {
          return {
            code: error.code,
            message: error.message,
            ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
          };
        }

        return {
          code: API_CODES.sftpOperationFailed,
          message: this.resolveErrorMessage(error, session.t('errors.sftp.operationFailedNoReason')),
          ...(resources.impact === 'mutation' ? { outcomeUnknown: true } : {}),
        };
      },
      onAbort: (reason) => {
        if (reason === 'deadline') {
          this.poisonUnusableSession(session);
        } else {
          this.markSessionUnavailable(session);
        }
      },
    });
    const snapshot = await handle.completion;
    void handle.released.then(() => {
      scheduler.forgetTask(handle.taskId);
      this.deleteClosedTaskSchedulerIfUnused(session.sessionId);
    });

    if (snapshot.state === 'succeeded' && snapshot.result !== undefined) {
      return snapshot.result;
    }

    const operationErrorCode: SftpOperationFailureCode | undefined =
      snapshot.failure?.code === API_CODES.sftpTaskDeadlineExceeded ||
      snapshot.failure?.code === SFTP_OPERATION_TIMEOUT_CODE
        ? SFTP_OPERATION_TIMEOUT_CODE
        : snapshot.state === 'cancelled' || snapshot.failure?.code === SFTP_TRANSPORT_CLOSED_CODE
          ? SFTP_TRANSPORT_CLOSED_CODE
          : undefined;
    const outcomeUnknown =
      resources.impact === 'mutation' &&
      snapshot.startedAt !== undefined &&
      (snapshot.state === 'cancelled' || snapshot.failure?.outcomeUnknown === true);

    return {
      type: 'failed',
      message: snapshot.failure?.message ?? session.t('errors.sftp.operationFailedNoReason'),
      ...(operationErrorCode ? { operationErrorCode } : {}),
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
    } as TResult;
  }

  /**
   * Prunes the oldest released terminal snapshots before accepting another public task.
   *
   * The renderer owns longer-lived viewed/focus attention in Phase 3. This backend bound prevents
   * an abandoned client from retaining request results without limit.
   *
   * @param sessionId Owning session id.
   * @param records Current public task records.
   * @returns Whether one more task can be retained.
   */
  private makeRoomForPublicTask(sessionId: string, records: Map<string, SftpPublicTaskRecord>): boolean {
    if (records.size < SFTP_TASK_RECORD_LIMIT_PER_SESSION) {
      return true;
    }

    for (const [taskId, record] of records) {
      if (!record.released) {
        continue;
      }
      const state = record.handle.getSnapshot().state;
      if (state !== 'succeeded' && state !== 'cancelled') {
        continue;
      }
      this.removePublicTaskRecord(sessionId, taskId, record);
      if (records.size < SFTP_TASK_RECORD_LIMIT_PER_SESSION) {
        return true;
      }
    }

    for (const [taskId, record] of records) {
      if (!record.released) {
        continue;
      }
      this.removePublicTaskRecord(sessionId, taskId, record);
      if (records.size < SFTP_TASK_RECORD_LIMIT_PER_SESSION) {
        return true;
      }
    }

    return false;
  }

  /**
   * Arms bounded terminal retention after the runner has released capacity and path claims.
   *
   * @param sessionId Owning session id.
   * @param taskId Retained task id.
   * @param record Retained task record.
   * @returns void.
   */
  private armPublicTaskRetention(sessionId: string, taskId: string, record: SftpPublicTaskRecord): void {
    if (record.retentionTimer) {
      return;
    }

    record.retentionTimer = setTimeout(() => {
      this.removePublicTaskRecord(sessionId, taskId, record);
    }, SFTP_TASK_TERMINAL_RETENTION_MS);
    record.retentionTimer.unref();
  }

  /**
   * Removes one matching terminal record and its scheduler history.
   *
   * @param sessionId Owning session id.
   * @param taskId Retained task id.
   * @param record Expected record identity.
   * @returns void.
   */
  private removePublicTaskRecord(sessionId: string, taskId: string, record: SftpPublicTaskRecord): void {
    const records = this.publicTaskRecords.get(sessionId);
    if (records?.get(taskId) !== record) {
      return;
    }

    if (record.retentionTimer) {
      clearTimeout(record.retentionTimer);
      record.retentionTimer = undefined;
    }
    records.delete(taskId);
    this.taskSchedulers.get(sessionId)?.forgetTask(taskId);
    if (records.size === 0 && !this.getOpenSession(sessionId)) {
      this.publicTaskRecords.delete(sessionId);
    }
    this.deleteClosedTaskSchedulerIfUnused(sessionId);
  }

  /**
   * Returns or creates the ordered public task record map for one session.
   *
   * @param sessionId Owning SFTP session id.
   * @returns Mutable insertion-ordered task record map.
   */
  private getOrCreatePublicTaskRecords(sessionId: string): Map<string, SftpPublicTaskRecord> {
    const existing = this.publicTaskRecords.get(sessionId);
    if (existing) {
      return existing;
    }

    const records = new Map<string, SftpPublicTaskRecord>();
    this.publicTaskRecords.set(sessionId, records);
    return records;
  }

  /**
   * Maps one public task descriptor to scheduler capacity and mutation semantics.
   *
   * @param request Validated task descriptor.
   * @returns Scheduler resource profile.
   */
  private resolveTaskResources(request: ApiSftpStartTaskRequest): SftpTaskResources {
    if (request.operation === 'download') {
      return {
        impact: 'read',
        workload: 'heavy',
        exclusive: false,
      };
    }
    if (request.operation === 'upload' || request.operation === 'batch') {
      return {
        impact: 'mutation',
        workload: 'heavy',
        exclusive: false,
      };
    }
    return {
      impact: 'mutation',
      workload: 'light',
      exclusive: false,
    };
  }

  /**
   * Extracts the remote paths that must remain reserved for one task.
   *
   * The scheduler canonicalizes relative paths to the remote root so ambiguous aliases serialize
   * conservatively without issuing uncoordinated realpath requests before admission.
   *
   * @param request Validated task descriptor.
   * @returns Remote path claims.
   */
  private resolveTaskRemotePaths(request: ApiSftpStartTaskRequest): string[] {
    switch (request.operation) {
      case 'create-file':
      case 'create-directory':
      case 'upload':
      case 'download':
        return [request.payload.path];
      case 'rename':
        return [request.payload.sourcePath, request.payload.targetPath];
      case 'batch':
        return [
          ...request.payload.entries.map((entry) => entry.path),
          ...(request.payload.targetDirectoryPath ? [request.payload.targetDirectoryPath] : []),
        ];
    }
  }

  /**
   * Executes one admitted task through the existing unscheduled operation primitives.
   *
   * @param sessionId Owning live SFTP session id.
   * @param request Validated task descriptor.
   * @param t Session-local translator retained for terminal failures after transport loss.
   * @returns Explicit scheduler outcome with a contract-shaped result.
   */
  private async executeTaskRequest(
    sessionId: string,
    request: ApiSftpStartTaskRequest,
    t: I18nInstance['t'],
  ): Promise<SftpTaskRunOutcome<ApiSftpTaskResult>> {
    switch (request.operation) {
      case 'create-file':
        return this.toTaskOperationOutcome(await this.createFilePrimitive(sessionId, request.payload.path), t);
      case 'create-directory':
        return this.toTaskOperationOutcome(await this.createDirectoryPrimitive(sessionId, request.payload.path), t);
      case 'rename':
        return this.toTaskOperationOutcome(
          await this.renameEntryPrimitive(sessionId, request.payload.sourcePath, request.payload.targetPath),
          t,
        );
      case 'upload': {
        const expectedRemoteSnapshot =
          request.payload.expectedSize !== undefined && request.payload.expectedModifiedAt
            ? {
                size: request.payload.expectedSize,
                modifiedAt: request.payload.expectedModifiedAt,
              }
            : undefined;
        return this.toTaskOperationOutcome(
          await this.uploadFilePrimitive(
            sessionId,
            request.payload.path,
            request.payload.localPath,
            expectedRemoteSnapshot,
            {
              overwrite: request.payload.overwrite,
              transferId: request.payload.transferId,
            },
          ),
          t,
        );
      }
      case 'download':
        return this.toTaskDownloadOutcome(
          await this.downloadFilePrimitive(
            sessionId,
            request.payload.path,
            request.payload.localPath,
            request.payload.transferId,
          ),
          t,
        );
      case 'batch':
        return this.toTaskBatchOutcome(await this.runBatchOperationPrimitive(sessionId, request.payload), t);
    }
  }

  /**
   * Converts a regular operation result into one retained task outcome.
   *
   * @param result Existing operation result.
   * @param t Session-local translator.
   * @returns Contract-shaped task outcome.
   */
  private toTaskOperationOutcome(
    result: SftpOperationResult,
    t: I18nInstance['t'],
  ): SftpTaskRunOutcome<ApiSftpTaskResult> {
    if (result.type === 'not-found') {
      return this.buildMissingSessionTaskOutcome(t);
    }
    if (result.type === 'failed') {
      return {
        state: 'failed',
        failure: this.resolveTaskFailure(result),
      };
    }

    return {
      state: 'succeeded',
      result: {
        type: 'operation',
        data: {
          sessionId: result.sessionId,
          path: result.path,
          ...(result.targetPath ? { targetPath: result.targetPath } : {}),
          ...(result.size !== undefined ? { size: result.size } : {}),
          ...(result.modifiedAt ? { modifiedAt: result.modifiedAt } : {}),
        },
      },
    };
  }

  /**
   * Converts a download result into one retained task outcome.
   *
   * @param result Existing download result.
   * @param t Session-local translator.
   * @returns Contract-shaped task outcome.
   */
  private toTaskDownloadOutcome(
    result: DownloadSftpFileResult,
    t: I18nInstance['t'],
  ): SftpTaskRunOutcome<ApiSftpTaskResult> {
    if (result.type === 'not-found') {
      return this.buildMissingSessionTaskOutcome(t);
    }
    if (result.type === 'failed') {
      return {
        state: 'failed',
        failure: this.resolveTaskFailure(result),
      };
    }

    return {
      state: 'succeeded',
      result: {
        type: 'download',
        data: {
          sessionId: result.sessionId,
          path: result.path,
          localPath: result.localPath,
          size: result.size,
        },
      },
    };
  }

  /**
   * Converts a batch result into a task outcome while retaining partial entry results.
   *
   * @param result Existing batch result.
   * @param t Session-local translator.
   * @returns Contract-shaped task outcome.
   */
  private toTaskBatchOutcome(
    result: SftpBatchOperationResult,
    t: I18nInstance['t'],
  ): SftpTaskRunOutcome<ApiSftpTaskResult> {
    if (result.type === 'not-found') {
      return this.buildMissingSessionTaskOutcome(t);
    }
    if (result.type === 'failed') {
      return {
        state: 'failed',
        failure: this.resolveTaskFailure(result),
      };
    }

    const taskResult: ApiSftpTaskResult = {
      type: 'batch',
      data: {
        sessionId: result.sessionId,
        operation: result.operation,
        totalCount: result.totalCount,
        completedCount: result.completedCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
        stoppedOnFailure: result.stoppedOnFailure,
        results: result.results,
      },
    };
    if (result.failedCount === 0) {
      return {
        state: 'succeeded',
        result: taskResult,
      };
    }

    const failedItem = result.results.find((item) => item.status === 'failed');
    return {
      state: 'failed',
      result: taskResult,
      failure: {
        code: failedItem?.operationErrorCode ?? API_CODES.sftpOperationFailed,
        message: failedItem?.message ?? t('errors.sftp.operationFailedNoReason'),
        ...(failedItem?.outcomeUnknown ? { outcomeUnknown: true } : {}),
      },
    };
  }

  /**
   * Builds the stable failure used when a queued task loses its owning session before execution.
   *
   * @param t Session-local translator.
   * @returns Failed task outcome.
   */
  private buildMissingSessionTaskOutcome(t: I18nInstance['t']): SftpTaskRunOutcome<ApiSftpTaskResult> {
    return {
      state: 'failed',
      failure: {
        code: API_CODES.sftpSessionNotFound,
        message: t('errors.sftp.sessionNotFound'),
      },
    };
  }

  /**
   * Maps existing operation failure metadata into the public task error model.
   *
   * @param result Existing failed operation result.
   * @returns Stable task failure.
   */
  private resolveTaskFailure(
    result: {
      message: string;
      reason?: 'remote-conflict';
    } & SftpOperationFailureMetadata,
  ): SftpTaskFailure {
    return {
      code:
        result.reason === 'remote-conflict'
          ? API_CODES.sftpUploadConflict
          : (result.operationErrorCode ?? API_CODES.sftpOperationFailed),
      message: result.message,
      ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
  }

  /**
   * Converts a scheduler snapshot into the stable OpenAPI task representation.
   *
   * @param record Public task metadata not owned by the generic scheduler.
   * @param snapshot Latest scheduler snapshot.
   * @returns API task data.
   */
  private toApiTaskData(
    record: SftpPublicTaskRecord,
    snapshot: SftpTaskSnapshot<ApiSftpTaskResult, ApiSftpTaskResult>,
  ): ApiSftpTaskData {
    const retainedResult = snapshot.result ?? snapshot.partialResult;
    const errorCode = snapshot.failure ? this.normalizeTaskErrorCode(snapshot.failure.code) : undefined;
    return {
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      operation: record.operation,
      state: snapshot.state,
      remotePaths: [...record.remotePaths],
      ...(record.transferId ? { transferId: record.transferId } : {}),
      createdAt: new Date(snapshot.createdAt).toISOString(),
      deadlineAt: new Date(snapshot.deadlineAt).toISOString(),
      ...(snapshot.startedAt !== undefined ? { startedAt: new Date(snapshot.startedAt).toISOString() } : {}),
      ...(snapshot.finishedAt !== undefined ? { finishedAt: new Date(snapshot.finishedAt).toISOString() } : {}),
      ...(retainedResult ? { result: retainedResult } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(snapshot.failure?.message ? { errorMessage: snapshot.failure.message } : {}),
      ...(snapshot.failure?.outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
  }

  /**
   * Restricts generic scheduler error strings to the OpenAPI task error vocabulary.
   *
   * @param code Scheduler failure code.
   * @returns Public task error code.
   */
  private normalizeTaskErrorCode(code: string): ApiSftpTaskErrorCode {
    return SFTP_TASK_ERROR_CODES.has(code as ApiSftpTaskErrorCode)
      ? (code as ApiSftpTaskErrorCode)
      : API_CODES.sftpOperationFailed;
  }

  /**
   * Waits briefly for cancelled task runners to release their remote ownership.
   *
   * The session transport is still closed after the bound so an unexpected runner bug cannot
   * reintroduce an indefinitely stuck close operation.
   *
   * @param scheduler Closing session's scheduler.
   * @returns void.
   */
  private async waitForTaskSchedulerDrain(scheduler: SftpTaskScheduler): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      scheduler.waitForIdle().then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), SFTP_TASK_CLOSE_DRAIN_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (!drained) {
      console.warn('[sftp] Session close stopped waiting for cancelled task runners.');
    }
  }

  /**
   * Closes one SFTP session and releases its SSH connection.
   *
   * @param sessionId Live SFTP session id.
   * @returns Promise resolving true when a session was found and closed.
   */
  public async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const scheduler = this.taskSchedulers.get(sessionId);
    scheduler?.cancelAll();
    this.markSessionUnavailable(session);
    if (scheduler) {
      await this.waitForTaskSchedulerDrain(scheduler);
    }
    await this.archiveService.closeSession(sessionId);
    try {
      session.client.end();
    } catch (error: unknown) {
      console.warn('[sftp] Failed to close SSH client.', error);
    }
    this.deleteClosedTaskSchedulerIfUnused(sessionId);

    return true;
  }

  /**
   * Returns the number of SFTP sessions that still own live SSH transports.
   *
   * @returns Active SFTP session count.
   */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Closes every active SFTP session without stopping the service.
   *
   * @returns Promise resolving to the number of sessions closed by this call.
   */
  public async closeAllSessions(): Promise<number> {
    const results = await Promise.all([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    return results.filter(Boolean).length;
  }

  /**
   * Stops all active SFTP sessions during backend shutdown.
   *
   * @returns Promise resolved after best-effort cleanup.
   */
  public async stop(): Promise<void> {
    await this.closeAllSessions();
    this.transfers.clear();
    for (const records of this.publicTaskRecords.values()) {
      for (const record of records.values()) {
        if (record.retentionTimer) {
          clearTimeout(record.retentionTimer);
        }
      }
    }
    this.taskSchedulers.clear();
    this.publicTaskRecords.clear();
  }

  /**
   * Resolves an active session and evicts stale transport handles before work starts.
   *
   * @param sessionId Candidate live SFTP session id.
   * @returns Open session when it can still accept SFTP work.
   */
  private getOpenSession(sessionId: string): SftpLiveSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.isClosed) {
      if (session?.isClosed) {
        this.sessions.delete(sessionId);
      }

      return null;
    }

    return session;
  }

  /**
   * Removes a session as soon as the underlying SSH transport is no longer usable.
   *
   * @param session Live session whose transport should be watched.
   * @returns void.
   */
  private watchSessionTransport(session: SftpLiveSession): void {
    const markClosed = (): void => {
      if (session.isClosed) {
        return;
      }

      this.markSessionUnavailable(session);
      this.archiveService.handleTransportClosed(session.sessionId);
      this.closeUnusableTransport(session);
    };

    this.getSessionOperationController(session);
    session.client.once('close', markClosed);
    session.client.once('end', markClosed);
    session.client.once('error', markClosed);
    session.sftp.once('close', markClosed);
    session.sftp.once('end', markClosed);
    session.sftp.once('error', markClosed);
  }

  /**
   * Returns the controller shared by ordinary operations using one SFTP channel.
   *
   * @param session Live or recently closed SFTP session.
   * @returns Session-level operation controller.
   */
  private getSessionOperationController(session: SftpLiveSession): AbortController {
    const existingController = this.sessionOperationControllers.get(session);
    if (existingController) {
      return existingController;
    }

    const controller = new AbortController();
    if (session.isClosed) {
      controller.abort();
    }
    this.sessionOperationControllers.set(session, controller);
    return controller;
  }

  /**
   * Evicts one session and immediately settles all guarded ordinary operations.
   *
   * @param session Session that can no longer accept ordinary SFTP requests.
   * @returns Whether this call transitioned an open session to closed.
   */
  private markSessionUnavailable(session: SftpLiveSession): boolean {
    const wasOpen = !session.isClosed;
    session.isClosed = true;
    if (this.sessions.get(session.sessionId) === session) {
      this.sessions.delete(session.sessionId);
    }

    const operationController = this.getSessionOperationController(session);
    if (!operationController.signal.aborted) {
      operationController.abort();
    }
    this.deleteClosedTaskSchedulerIfUnused(session.sessionId);
    return wasOpen;
  }

  /**
   * Invalidates a shared SFTP channel after a timeout or transport-level failure.
   *
   * An interrupted mutation may have reached the server, so the channel is never reused and all
   * sibling operations are aborted before the SSH client begins best-effort shutdown.
   *
   * @param session Session that owns the failed request.
   * @returns void.
   */
  private poisonUnusableSession(session: SftpLiveSession): void {
    const wasOpen = this.markSessionUnavailable(session);
    if (!wasOpen) {
      return;
    }

    this.archiveService.handleTransportClosed(session.sessionId);
    this.closeUnusableTransport(session);
  }

  /**
   * Destroys an unusable SFTP channel and closes its owning SSH client.
   *
   * @param session Session whose transport cannot be reused.
   * @returns void.
   */
  private closeUnusableTransport(session: SftpLiveSession): void {
    try {
      session.sftp.destroy();
    } catch (destroyError: unknown) {
      console.warn('[sftp] Failed to destroy an unusable SFTP channel.', destroyError);
    }

    try {
      session.client.destroy();
    } catch (closeError: unknown) {
      console.warn('[sftp] Failed to destroy the SSH client after an SFTP transport failure.', closeError);
    }
  }

  /**
   * Runs one ordinary SFTP request with the shared session lifecycle boundary.
   *
   * @template T Operation result type.
   * @param session Session that owns the request.
   * @param operation Stable diagnostic operation name.
   * @param impact Whether the request may mutate remote state.
   * @param start Callback or stream operation factory.
   * @returns Operation result before the idle, absolute, or transport deadline.
   */
  private async runSftpOperation<T>(
    session: SftpLiveSession,
    operation: string,
    impact: SftpOperationImpact,
    start: (context: SftpOperationGuardContext) => Promise<T>,
  ): Promise<T> {
    const operationController = this.getSessionOperationController(session);
    try {
      return await runGuardedSftpOperation({
        operation,
        impact,
        idleTimeoutMs: this.sftpOperationIdleTimeoutMs,
        absoluteTimeoutMs: this.sftpOperationAbsoluteTimeoutMs,
        transportSignal: operationController.signal,
        start,
        onTimeout: () => this.poisonUnusableSession(session),
      });
    } catch (error: unknown) {
      if (isSftpOperationFailure(error) || !this.isSftpTransportFailure(error)) {
        throw error;
      }

      const transportError = new SftpOperationFailure(SFTP_TRANSPORT_CLOSED_CODE, operation, impact);
      this.poisonUnusableSession(session);
      throw transportError;
    }
  }

  /**
   * Adapts one ssh2 callback request to the common guarded operation lifecycle.
   *
   * @template T Callback result type.
   * @param session Session that owns the request.
   * @param operation Stable diagnostic operation name.
   * @param impact Whether the request may mutate remote state.
   * @param start Starts the ssh2 callback request.
   * @returns Callback result before the idle, absolute, or transport deadline.
   */
  private async runSftpCallbackOperation<T>(
    session: SftpLiveSession,
    operation: string,
    impact: SftpOperationImpact,
    start: (callback: SftpOperationCallback<T>) => void,
  ): Promise<T> {
    return await this.runSftpOperation(session, operation, impact, async () => {
      return await new Promise<T>((resolve, reject) => {
        start((error, value) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(value as T);
        });
      });
    });
  }

  private async resolveRealPath(session: SftpLiveSession, inputPath: string): Promise<string | null> {
    try {
      return await this.runSftpCallbackOperation(session, 'realpath', 'read', (callback) => {
        session.sftp.realpath(inputPath, callback);
      });
    } catch (error: unknown) {
      if (isSftpOperationFailure(error)) {
        throw error;
      }

      return null;
    }
  }

  /**
   * Resolves one path into the common SFTP entry metadata contract.
   *
   * @param session Live SFTP session.
   * @param targetPath Normalized remote path.
   * @returns Per-path details item.
   */
  private async getSingleEntryDetails(session: SftpLiveSession, targetPath: string): Promise<SftpEntryDetailsItem> {
    try {
      const stats = await this.lstat(session, targetPath);
      const entryType = resolveSftpEntryType(stats.mode);
      const symlinkTarget =
        entryType === 'symlink' ? await this.resolveSymlinkTargetMetadata(session, targetPath) : undefined;

      return {
        path: targetPath,
        status: 'success',
        entry: this.buildSftpEntry({
          name: this.resolveEntryName(targetPath),
          path: targetPath,
          stats,
          ...(symlinkTarget ? { symlinkTarget } : {}),
        }),
      };
    } catch (error: unknown) {
      return {
        path: targetPath,
        status: 'failed',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.operationFailedNoReason')),
        ...this.resolveOperationFailureMetadata(error),
      };
    }
  }

  /**
   * Builds the shared SFTP entry shape used by list and details APIs.
   *
   * @param input Raw stats and path information.
   * @returns API-ready SFTP entry metadata.
   */
  private buildSftpEntry(input: {
    name: string;
    path: string;
    stats: Stats;
    longname?: string;
    symlinkTarget?: SftpSymlinkTarget;
  }): SftpEntry {
    const type = resolveSftpEntryType(input.stats.mode);

    return {
      name: input.name,
      path: input.path,
      parentPath: this.resolveParentPath(input.path),
      type,
      size: input.stats.size,
      mode: input.stats.mode,
      permissions: formatSftpPermissions(input.stats.mode),
      permissionOctal: formatSftpPermissionOctal(input.stats.mode),
      uid: input.stats.uid,
      gid: input.stats.gid,
      modifiedAt: this.formatStatsTimestamp(input.stats.mtime),
      accessedAt: this.formatStatsTimestamp(input.stats.atime),
      extension: this.resolveEntryExtension(input.name, type),
      shellEscapedPath: escapeSftpShellPath(input.path),
      isHidden: resolveSftpEntryHiddenState(input.name, input.stats),
      ...(input.longname ? { longname: input.longname } : {}),
      ...(input.symlinkTarget ? { symlinkTarget: input.symlinkTarget } : {}),
    };
  }

  /**
   * Reads and stats a symbolic link target without failing the link metadata fetch.
   *
   * @param session Live SFTP session.
   * @param linkPath Normalized symbolic link path.
   * @returns Target metadata or broken/permission status.
   */
  private async resolveSymlinkTargetMetadata(session: SftpLiveSession, linkPath: string): Promise<SftpSymlinkTarget> {
    try {
      const targetPath = await this.readlink(session, linkPath);
      const resolvedPath = this.resolveSymlinkTargetPath(linkPath, targetPath);
      const baseTarget = {
        path: targetPath,
        resolvedPath,
        isAbsolute: targetPath.startsWith('/'),
      };

      try {
        const targetStats = await this.stat(session, resolvedPath);
        return {
          ...baseTarget,
          status: 'exists',
          type: resolveSftpEntryType(targetStats.mode),
          size: targetStats.size,
          mode: targetStats.mode,
          permissions: formatSftpPermissions(targetStats.mode),
          permissionOctal: formatSftpPermissionOctal(targetStats.mode),
          modifiedAt: this.formatStatsTimestamp(targetStats.mtime),
          accessedAt: this.formatStatsTimestamp(targetStats.atime),
        };
      } catch (error: unknown) {
        if (isSftpOperationFailure(error)) {
          throw error;
        }

        return {
          ...baseTarget,
          status: this.resolveSymlinkTargetStatus(error),
          message: this.resolveErrorMessage(error, session.t('errors.sftp.operationFailedNoReason')),
        };
      }
    } catch (error: unknown) {
      if (isSftpOperationFailure(error)) {
        throw error;
      }

      return {
        status: 'unknown',
        message: this.resolveErrorMessage(error, session.t('errors.sftp.operationFailedNoReason')),
      };
    }
  }

  /**
   * Resolves a readlink target relative to the symlink parent when needed.
   *
   * @param linkPath Normalized symbolic link path.
   * @param targetPath Raw readlink target.
   * @returns Absolute or normalized relative target path.
   */
  private resolveSymlinkTargetPath(linkPath: string, targetPath: string): string {
    if (targetPath.startsWith('/')) {
      return normalizeSftpPathInput(targetPath);
    }

    return joinSftpPath(this.resolveParentPath(linkPath) ?? '.', targetPath);
  }

  /**
   * Formats stats timestamps defensively because some SFTP servers omit atime/mtime.
   *
   * @param seconds POSIX timestamp in seconds.
   * @returns ISO timestamp.
   */
  private formatStatsTimestamp(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }

  /**
   * Compares the current remote metadata with the snapshot captured when the temp file was opened.
   *
   * @param stats Current remote file stats.
   * @param expectedSnapshot Renderer-provided opening snapshot.
   * @returns Whether the remote file still matches the opened version.
   */
  private doesRemoteSnapshotMatch(stats: Stats, expectedSnapshot: UploadSftpFileConflictSnapshot): boolean {
    const expectedModifiedSeconds = Math.trunc(Date.parse(expectedSnapshot.modifiedAt) / 1000);
    return stats.size === expectedSnapshot.size && stats.mtime === expectedModifiedSeconds;
  }

  /**
   * Resolves the display name for an entry path.
   *
   * @param targetPath Normalized remote path.
   * @returns Basename or root marker.
   */
  private resolveEntryName(targetPath: string): string {
    if (targetPath === '/') {
      return '/';
    }

    return POSIX_PATH.basename(targetPath) || targetPath;
  }

  /**
   * Extracts a file extension for list columns and sorting.
   *
   * @param name Entry basename.
   * @param type Entry type.
   * @returns Lowercase extension without the leading dot.
   */
  private resolveEntryExtension(name: string, type: SftpEntryType): string {
    if (type !== 'file' && type !== 'symlink') {
      return '';
    }

    const extension = POSIX_PATH.extname(name).replace(/^\./, '');
    return extension.toLowerCase();
  }

  private resolveParentPath(inputPath: string): string | undefined {
    if (!inputPath || inputPath === '/') {
      return undefined;
    }

    const parentPath = POSIX_PATH.dirname(inputPath);
    return parentPath === inputPath ? undefined : parentPath || '/';
  }

  /**
   * Reads one remote directory through a bounded SFTP callback.
   *
   * @param session Live SFTP session.
   * @param directoryPath Remote directory path.
   * @returns Directory entries returned by the server.
   */
  private async readdir(session: SftpLiveSession, directoryPath: string): Promise<SftpDirectoryEntry[]> {
    return await this.runSftpCallbackOperation(session, 'readdir', 'read', (callback) => {
      session.sftp.readdir(directoryPath, (error, entries) => {
        callback(error, entries);
      });
    });
  }

  /**
   * Reads one remote symbolic-link target through a bounded SFTP callback.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote symbolic-link path.
   * @returns Raw link target returned by the server.
   */
  private async readlink(session: SftpLiveSession, targetPath: string): Promise<string> {
    return await this.runSftpCallbackOperation(session, 'readlink', 'read', (callback) => {
      const sftp = session.sftp as SftpReadlinkWrapper;
      sftp.readlink(targetPath, (error, linkString) => {
        callback(error, linkString);
      });
    });
  }

  /**
   * Creates one symbolic link through the active SFTP subsystem.
   *
   * @param session Live SFTP session.
   * @param targetPath Absolute remote path the new link should point to.
   * @param linkPath Remote path where the symlink should be created.
   * @returns Nothing.
   */
  private async symlink(session: SftpLiveSession, targetPath: string, linkPath: string): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'symlink', 'mutation', (callback) => {
      const sftp = session.sftp as SftpSymlinkWrapper;
      sftp.symlink(targetPath, linkPath, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Follows one remote path and returns bounded metadata.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote path.
   * @returns Remote path metadata.
   */
  private async stat(session: SftpLiveSession, targetPath: string): Promise<Stats> {
    return await this.runSftpCallbackOperation(session, 'stat', 'read', (callback) => {
      session.sftp.stat(targetPath, (error, stats) => {
        callback(error, stats);
      });
    });
  }

  /**
   * Reads one remote path without following symbolic links.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote path.
   * @returns Remote path metadata.
   */
  private async lstat(session: SftpLiveSession, targetPath: string): Promise<Stats> {
    return await this.runSftpCallbackOperation(session, 'lstat', 'read', (callback) => {
      session.sftp.lstat(targetPath, (error, stats) => {
        callback(error, stats);
      });
    });
  }

  /**
   * Opens one remote file handle with bounded callback completion.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote file path.
   * @param mode Read or write mode.
   * @returns Opaque SFTP file handle.
   */
  private async open(session: SftpLiveSession, targetPath: string, mode: 'r' | 'w'): Promise<Buffer> {
    return await this.runSftpCallbackOperation(session, 'open', mode === 'w' ? 'mutation' : 'read', (callback) => {
      session.sftp.open(targetPath, mode, (error, handle) => {
        callback(error, handle);
      });
    });
  }

  /**
   * Closes one remote file handle without allowing cleanup to stall indefinitely.
   *
   * @param session Live SFTP session.
   * @param handle Opaque SFTP file handle.
   * @returns Nothing.
   */
  private async closeHandle(session: SftpLiveSession, handle: Buffer): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'close-handle', 'read', (callback) => {
      session.sftp.close(handle, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Reads until the requested preview buffer is filled or the server reports EOF.
   *
   * @param session Live SFTP session.
   * @param handle Open remote file handle.
   * @param buffer Destination buffer.
   * @param length Maximum bytes to read.
   * @returns Number of bytes actually read.
   */
  private async readFullyIntoBuffer(
    session: SftpLiveSession,
    handle: Buffer,
    buffer: Buffer,
    length: number,
  ): Promise<number> {
    let bytesReadTotal = 0;
    while (bytesReadTotal < length) {
      const nextReadLength = length - bytesReadTotal;
      const bytesRead = await this.read(session, handle, buffer, bytesReadTotal, nextReadLength, bytesReadTotal);
      if (bytesRead <= 0) {
        break;
      }

      bytesReadTotal += bytesRead;
    }

    return bytesReadTotal;
  }

  /**
   * Reads one SFTP chunk at a specific file position.
   *
   * @param session Live SFTP session.
   * @param handle Open remote file handle.
   * @param buffer Destination buffer.
   * @param offset Destination buffer offset.
   * @param length Number of bytes to request.
   * @param position Remote file position.
   * @returns Number of bytes read by the server.
   */
  private async read(
    session: SftpLiveSession,
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    return await this.runSftpCallbackOperation(session, 'read', 'read', (callback) => {
      session.sftp.read(handle, buffer, offset, length, position, (error, bytesRead) => {
        callback(error, bytesRead);
      });
    });
  }

  /**
   * Creates one new remote file from an in-memory buffer.
   *
   * @param session Live SFTP session.
   * @param targetPath New remote file path.
   * @param data File content.
   * @param mode Remote permission bits.
   * @returns Nothing.
   */
  private async writeFile(session: SftpLiveSession, targetPath: string, data: Buffer, mode: number): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'write-file', 'mutation', (callback) => {
      session.sftp.writeFile(targetPath, data, { mode, flag: 'wx' }, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Creates one remote directory through a bounded mutation callback.
   *
   * @param session Live SFTP session.
   * @param targetPath New remote directory path.
   * @param mode Remote permission bits.
   * @returns Nothing.
   */
  private async mkdir(session: SftpLiveSession, targetPath: string, mode: number): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'mkdir', 'mutation', (callback) => {
      session.sftp.mkdir(targetPath, { mode }, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Removes one remote file or symbolic link through a bounded mutation callback.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote entry path.
   * @returns Nothing.
   */
  private async unlink(session: SftpLiveSession, targetPath: string): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'unlink', 'mutation', (callback) => {
      session.sftp.unlink(targetPath, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Removes one empty remote directory through a bounded mutation callback.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote directory path.
   * @returns Nothing.
   */
  private async rmdir(session: SftpLiveSession, targetPath: string): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'rmdir', 'mutation', (callback) => {
      session.sftp.rmdir(targetPath, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Renames one remote entry through a bounded mutation callback.
   *
   * @param session Live SFTP session.
   * @param sourcePath Existing remote path.
   * @param targetPath Desired remote path.
   * @returns Nothing.
   */
  private async rename(session: SftpLiveSession, sourcePath: string, targetPath: string): Promise<void> {
    await this.runSftpCallbackOperation<void>(session, 'rename', 'mutation', (callback) => {
      session.sftp.rename(sourcePath, targetPath, (error) => {
        callback(error);
      });
    });
  }

  /**
   * Uses the OpenSSH atomic rename extension when the connected server exposes it.
   *
   * @param session Live SFTP session.
   * @param sourcePath Remote temp source path.
   * @param targetPath Remote target path.
   * @returns Whether the extension was available and completed successfully.
   */
  private async tryOpenSshPosixRename(
    session: SftpLiveSession,
    sourcePath: string,
    targetPath: string,
  ): Promise<boolean> {
    const posixRename = (session.sftp as SFTPWrapper & SftpOpenSshExtensions).ext_openssh_rename;
    if (!posixRename) {
      return false;
    }

    await this.runSftpCallbackOperation<void>(session, 'posix-rename', 'mutation', (callback) => {
      posixRename.call(session.sftp, sourcePath, targetPath, (error) => {
        callback(error);
      });
    });

    return true;
  }

  /**
   * Rechecks the opened-file conflict guard immediately before non-atomic fallback replacement.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote file path.
   * @param expectedRemoteSnapshot Remote metadata captured when the file was opened.
   * @returns Nothing.
   */
  private async assertRemoteSnapshotStillMatches(
    session: SftpLiveSession,
    targetPath: string,
    expectedRemoteSnapshot: UploadSftpFileConflictSnapshot,
  ): Promise<void> {
    const currentStats = await this.stat(session, targetPath);
    if (!currentStats.isFile() || !this.doesRemoteSnapshotMatch(currentStats, expectedRemoteSnapshot)) {
      throw new SftpRemoteConflictError(session.t('errors.sftp.fileUploadRemoteChanged'));
    }
  }

  /**
   * Replaces a remote regular file with an uploaded temp file across common SFTP server behaviors.
   *
   * @param session Live SFTP session.
   * @param temporaryPath Uploaded remote temp file path.
   * @param targetPath Remote target file path.
   * @param expectedRemoteSnapshot Remote metadata captured when the file was opened.
   * @returns Nothing.
   */
  private async replaceRemoteFileFromTemp(
    session: SftpLiveSession,
    temporaryPath: string,
    targetPath: string,
    options: RemoteFileReplacementOptions,
  ): Promise<void> {
    try {
      if (await this.tryOpenSshPosixRename(session, temporaryPath, targetPath)) {
        return;
      }
    } catch (error: unknown) {
      if (isSftpOperationFailure(error)) {
        throw error;
      }

      // Fall through to portable replacement; not every server accepts the OpenSSH extension for all paths.
    }

    try {
      await this.rename(session, temporaryPath, targetPath);
      return;
    } catch (renameError: unknown) {
      if (!this.isGenericSftpFailureError(renameError)) {
        throw renameError;
      }

      if (options.expectedRemoteSnapshot) {
        await this.assertRemoteSnapshotStillMatches(session, targetPath, options.expectedRemoteSnapshot);
      }
      await this.unlink(session, targetPath);
      try {
        await this.rename(session, temporaryPath, targetPath);
      } catch (replaceError: unknown) {
        throw replaceError instanceof Error && replaceError.message.trim().length > 0 ? replaceError : renameError;
      }
    }
  }

  /**
   * Best-effort removes a remote temp file created during upload replacement.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote temp path.
   * @returns Nothing.
   */
  private async unlinkRemoteTempFile(session: SftpLiveSession, targetPath: string): Promise<void> {
    try {
      await this.unlink(session, targetPath);
    } catch (error: unknown) {
      const diagnostic = isSftpOperationFailure(error)
        ? {
            code: error.code,
            operation: error.operation,
            outcomeUnknown: error.outcomeUnknown,
          }
        : {
            name: error instanceof Error ? error.name : 'UnknownError',
          };
      console.warn(
        '[sftp] Failed to remove a remote upload temporary file; preserving the primary upload failure.',
        diagnostic,
      );
    }
  }

  /**
   * Detects path existence without hiding transport or timeout failures.
   *
   * @param session Live SFTP session.
   * @param targetPath Remote path to inspect.
   * @returns Whether the remote path exists.
   */
  private async pathExists(session: SftpLiveSession, targetPath: string): Promise<boolean> {
    try {
      await this.stat(session, targetPath);
      return true;
    } catch (error: unknown) {
      if (this.isNoSuchFileError(error)) {
        return false;
      }

      throw error;
    }
  }

  private normalizeReadFileMaxBytes(requestedMaxBytes: number | undefined): number {
    if (!requestedMaxBytes || !Number.isFinite(requestedMaxBytes)) {
      return DEFAULT_READ_FILE_MAX_BYTES;
    }

    return Math.min(Math.max(Math.trunc(requestedMaxBytes), 1024), MAX_READ_FILE_MAX_BYTES);
  }

  private async resolveAvailableCopyPath(session: SftpLiveSession, targetPath: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidatePath = buildSftpCopyTargetCandidate(targetPath, attempt);
      if (!(await this.pathExists(session, candidatePath))) {
        return candidatePath;
      }
    }

    throw new Error(session.t('errors.sftp.copyTargetConflict'));
  }

  private async runSingleBatchEntryOperation(
    sessionId: string,
    operation: SftpBatchOperation,
    entry: SftpBatchOperationEntry,
    targetDirectoryPath: string | undefined,
  ): Promise<SftpOperationResult> {
    if (operation === 'delete') {
      return await this.deleteEntryPrimitive(sessionId, entry.path, entry.type === 'directory');
    }

    const targetPath = joinSftpPath(targetDirectoryPath ?? '.', POSIX_PATH.basename(entry.path));
    if (operation === 'copy') {
      return await this.copyEntryPrimitive(sessionId, entry.path, targetPath);
    }

    if (operation === 'link') {
      return await this.linkEntryPrimitive(sessionId, entry.path, targetPath);
    }

    return await this.renameEntryPrimitive(sessionId, entry.path, targetPath);
  }

  private async copyFile(
    session: SftpLiveSession,
    sourcePath: string,
    targetPath: string,
    sourceStats: Stats,
  ): Promise<void> {
    await this.runSftpOperation(session, 'copy-stream', 'mutation', async ({ signal, markProgress }) => {
      const readStream = session.sftp.createReadStream(sourcePath, { flags: 'r' });
      const writeStream = session.sftp.createWriteStream(targetPath, {
        flags: 'wx',
        mode: sourceStats.mode & 0o777,
      });
      await pipeline(readStream, this.createTransferCountingStream(undefined, markProgress), writeStream, { signal });
    });
  }

  /**
   * Resolves a renderer-supplied upload source into a canonical Main-owned temp file path.
   *
   * @param localPath Renderer-supplied local temp path.
   * @returns Canonical local file path, or null when validation fails.
   */
  private async resolveExistingUploadLocalPath(localPath: string): Promise<string | null> {
    const normalizedLocalPath = path.resolve(localPath);
    if (!isLocalPathInsideDirectory(normalizedLocalPath, this.sftpTemporaryRootPath)) {
      return null;
    }

    try {
      const localStats = await fs.lstat(normalizedLocalPath);
      if (!localStats.isFile() || localStats.isSymbolicLink()) {
        return null;
      }

      const canonicalLocalPath = await fs.realpath(normalizedLocalPath);
      if (!isLocalPathInsideDirectory(canonicalLocalPath, this.sftpTemporaryRootPath)) {
        return null;
      }

      return canonicalLocalPath;
    } catch {
      return null;
    }
  }

  /**
   * Streams one remote file to a temporary local file before replacing the final destination.
   *
   * @param session Live SFTP session.
   * @param sourcePath Remote file path.
   * @param localPath Final local destination path.
   * @returns Nothing.
   */
  private async downloadFileToLocalPath(
    session: SftpLiveSession,
    sourcePath: string,
    localPath: string,
    transferId?: string,
  ): Promise<void> {
    const localDirectory = path.dirname(localPath);
    const temporaryPath = path.join(
      localDirectory,
      `.${path.basename(localPath)}.cosmosh-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );

    await fs.mkdir(localDirectory, { recursive: true });

    try {
      await this.runSftpOperation(session, 'download-stream', 'read', async ({ signal, markProgress }) => {
        const readStream = session.sftp.createReadStream(sourcePath, { flags: 'r' });
        const shouldHardenTemporaryFile = isLocalPathInsideDirectory(
          path.resolve(localPath),
          this.sftpTemporaryRootPath,
        );
        const writeStream = createWriteStream(temporaryPath, {
          flags: 'wx',
          ...(shouldHardenTemporaryFile ? { mode: 0o600 } : {}),
        });
        await pipeline(readStream, this.createTransferCountingStream(transferId, markProgress), writeStream, {
          signal,
        });
      });
      await fs.rename(temporaryPath, localPath);
    } catch (error: unknown) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Streams a local file into a remote temp file before replacing the target path atomically when possible.
   *
   * @param session Live SFTP session.
   * @param localPath Existing local file path.
   * @param targetPath Remote file path to replace.
   * @param mode Remote file permission bits to preserve.
   * @returns Nothing.
   */
  private async uploadLocalFileToRemotePath(
    session: SftpLiveSession,
    localPath: string,
    targetPath: string,
    mode: number,
    options: RemoteFileReplacementOptions,
    transferId?: string,
  ): Promise<void> {
    const remoteDirectory = this.resolveParentPath(targetPath) ?? '.';
    const temporaryPath = joinSftpPath(
      remoteDirectory,
      `.${this.resolveEntryName(targetPath)}.cosmosh-${Date.now()}-${randomUUID()}.tmp`,
    );

    try {
      await this.runSftpOperation(session, 'upload-stream', 'mutation', async ({ signal, markProgress }) => {
        const readStream = createReadStream(localPath, { flags: 'r' });
        const writeStream = session.sftp.createWriteStream(temporaryPath, { flags: 'wx', mode });
        await pipeline(readStream, this.createTransferCountingStream(transferId, markProgress), writeStream, {
          signal,
        });
      });
      await this.replaceRemoteFileFromTemp(session, temporaryPath, targetPath, options);
    } catch (error: unknown) {
      await this.unlinkRemoteTempFile(session, temporaryPath);
      throw error;
    }
  }

  /**
   * Streams a local file into a new remote path without replacing an existing entry.
   *
   * @param session Live SFTP session.
   * @param localPath Existing local file path.
   * @param targetPath New remote file path.
   * @param mode Initial remote permission bits.
   * @returns Nothing.
   */
  private async createRemoteFileFromLocalPath(
    session: SftpLiveSession,
    localPath: string,
    targetPath: string,
    mode: number,
    transferId?: string,
  ): Promise<void> {
    let didOpenTarget = false;

    try {
      await this.runSftpOperation(session, 'upload-stream', 'mutation', async ({ signal, markProgress }) => {
        const readStream = createReadStream(localPath, { flags: 'r' });
        const writeStream = session.sftp.createWriteStream(targetPath, { flags: 'wx', mode });
        writeStream.once('open', () => {
          didOpenTarget = true;
        });
        await pipeline(readStream, this.createTransferCountingStream(transferId, markProgress), writeStream, {
          signal,
        });
      });
    } catch (error: unknown) {
      if (this.isFileAlreadyExistsError(error)) {
        throw new SftpRemoteConflictError(session.t('errors.sftp.fileUploadTargetExists'));
      }

      if (didOpenTarget) {
        await this.unlinkRemoteTempFile(session, targetPath);
      }
      throw error;
    }
  }

  /**
   * Creates or resets the progress record for a transfer that is about to stream bytes.
   *
   * @param transferId Optional renderer-generated identifier.
   * @param direction Transfer direction.
   * @param totalBytes Total file size known before streaming begins.
   * @returns void.
   */
  private beginTransfer(transferId: string | undefined, direction: SftpTransferDirection, totalBytes: number): void {
    if (!transferId) {
      return;
    }

    this.pruneExpiredTransfers();
    const now = Date.now();
    this.transfers.set(transferId, {
      transferId,
      direction,
      status: 'running',
      transferredBytes: 0,
      totalBytes: Math.max(0, totalBytes),
      bytesPerSecond: 0,
      startedAt: now,
      updatedAt: now,
      lastSpeedSampleAt: now,
      lastSpeedSampleBytes: 0,
    });
  }

  /**
   * Creates a binary pass-through stream that updates progress without buffering file contents.
   *
   * @param transferId Optional renderer-generated identifier.
   * @param markProgress Optional operation-idle deadline refresh callback.
   * @returns Transform stream suitable for Node pipeline composition.
   */
  private createTransferCountingStream(transferId: string | undefined, markProgress?: () => void): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback): void => {
        markProgress?.();
        this.recordTransferredBytes(transferId, chunk.byteLength);
        callback(null, chunk);
      },
    });
  }

  /**
   * Records streamed bytes and periodically refreshes a smoothed transfer rate.
   *
   * @param transferId Optional renderer-generated identifier.
   * @param byteLength Number of bytes in the latest stream chunk.
   * @returns void.
   */
  private recordTransferredBytes(transferId: string | undefined, byteLength: number): void {
    if (!transferId) {
      return;
    }

    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.status !== 'running') {
      return;
    }

    const now = Date.now();
    transfer.transferredBytes += Math.max(0, byteLength);
    transfer.updatedAt = now;

    const sampleDurationMs = now - transfer.lastSpeedSampleAt;
    if (sampleDurationMs < SFTP_TRANSFER_SPEED_SAMPLE_INTERVAL_MS) {
      return;
    }

    const sampleBytes = transfer.transferredBytes - transfer.lastSpeedSampleBytes;
    const sampledRate = (sampleBytes * 1000) / sampleDurationMs;
    transfer.bytesPerSecond =
      transfer.bytesPerSecond === 0 ? sampledRate : transfer.bytesPerSecond * 0.65 + sampledRate * 0.35;
    transfer.lastSpeedSampleAt = now;
    transfer.lastSpeedSampleBytes = transfer.transferredBytes;
  }

  /**
   * Marks a transfer complete while preserving its last measured speed for the recent-task UI.
   *
   * @param transferId Optional renderer-generated identifier.
   * @returns void.
   */
  private completeTransfer(transferId: string | undefined): void {
    if (!transferId) {
      return;
    }

    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }

    const now = Date.now();
    transfer.status = 'completed';
    transfer.totalBytes = Math.max(transfer.totalBytes, transfer.transferredBytes);
    const finalSampleDurationMs = now - transfer.lastSpeedSampleAt;
    const finalSampleBytes = transfer.transferredBytes - transfer.lastSpeedSampleBytes;
    if (finalSampleDurationMs > 0 && finalSampleBytes > 0) {
      const sampledRate = (finalSampleBytes * 1000) / finalSampleDurationMs;
      transfer.bytesPerSecond =
        transfer.bytesPerSecond === 0 ? sampledRate : transfer.bytesPerSecond * 0.65 + sampledRate * 0.35;
    }
    transfer.updatedAt = now;
    transfer.finishedAt = now;
  }

  /**
   * Marks a started transfer failed and retains its localized failure reason temporarily.
   *
   * @param transferId Optional renderer-generated identifier.
   * @param errorMessage Localized transfer failure reason.
   * @returns void.
   */
  private failTransfer(transferId: string | undefined, errorMessage: string): void {
    if (!transferId) {
      return;
    }

    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      return;
    }

    const now = Date.now();
    transfer.status = 'failed';
    transfer.updatedAt = now;
    transfer.finishedAt = now;
    transfer.errorMessage = errorMessage;
  }

  /**
   * Removes terminal transfer records after the bounded UI inspection window.
   *
   * @returns void.
   */
  private pruneExpiredTransfers(): void {
    const expirationBoundary = Date.now() - SFTP_TRANSFER_RETENTION_MS;
    for (const [transferId, transfer] of this.transfers) {
      if (transfer.finishedAt !== undefined && transfer.finishedAt < expirationBoundary) {
        this.transfers.delete(transferId);
      }
    }
  }

  /**
   * Writes an in-memory buffer through a remote temp file before replacing the target.
   *
   * @param session Live SFTP session.
   * @param data File content.
   * @param targetPath Remote file path to replace.
   * @param mode Remote file permission bits to preserve.
   * @param options Remote replacement conflict options.
   * @returns Nothing.
   */
  private async writeBufferToRemotePath(
    session: SftpLiveSession,
    data: Buffer,
    targetPath: string,
    mode: number,
    options: RemoteFileReplacementOptions,
  ): Promise<void> {
    const remoteDirectory = this.resolveParentPath(targetPath) ?? '.';
    const temporaryPath = joinSftpPath(
      remoteDirectory,
      `.${this.resolveEntryName(targetPath)}.cosmosh-${Date.now()}-${randomUUID()}.tmp`,
    );

    try {
      await this.writeFile(session, temporaryPath, data, mode);
      await this.replaceRemoteFileFromTemp(session, temporaryPath, targetPath, options);
    } catch (error: unknown) {
      await this.unlinkRemoteTempFile(session, temporaryPath);
      throw error;
    }
  }

  private async copyEntryRecursive(session: SftpLiveSession, sourcePath: string, targetPath: string): Promise<void> {
    const sourceStats = await this.lstat(session, sourcePath);
    if (sourceStats.isDirectory()) {
      await this.mkdir(session, targetPath, sourceStats.mode & 0o777);
      const children = await this.readdir(session, sourcePath);
      for (const child of children) {
        if (child.filename === '.' || child.filename === '..') {
          continue;
        }

        await this.copyEntryRecursive(
          session,
          joinSftpPath(sourcePath, child.filename),
          joinSftpPath(targetPath, child.filename),
        );
      }
      return;
    }

    if (sourceStats.isFile()) {
      await this.copyFile(session, sourcePath, targetPath, sourceStats);
      return;
    }

    throw new Error(session.t('errors.sftp.entryCopyUnsupported'));
  }

  private async deleteEntryRecursive(session: SftpLiveSession, targetPath: string, recursive: boolean): Promise<void> {
    const stats = await this.lstat(session, targetPath);
    if (!stats.isDirectory()) {
      await this.unlink(session, targetPath);
      return;
    }

    if (!recursive) {
      await this.rmdir(session, targetPath);
      return;
    }

    const entries = await this.readdir(session, targetPath);
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') {
        continue;
      }

      await this.deleteEntryRecursive(session, joinSftpPath(targetPath, entry.filename), true);
    }

    await this.rmdir(session, targetPath);
  }

  private isSameOrDescendantPath(sourcePath: string, targetPath: string): boolean {
    const normalizedSource = sourcePath.replace(/\/+$/, '');
    const normalizedTarget = targetPath.replace(/\/+$/, '');
    return normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}/`);
  }

  private logSftpAuditEvent(input: AuditEventInput): void {
    void this.auditEventService.logEvent(input);
  }

  private logSftpMutation(session: SftpLiveSession, action: string, metadata: Record<string, unknown>): void {
    this.logSftpAuditEvent({
      category: 'sftp-session',
      action,
      outcome: 'success',
      severity: 'info',
      entityType: 'ssh-server',
      entityId: session.serverId,
      sessionId: session.sessionId,
      metadata,
    });
  }

  /**
   * Classifies target stat failures into user-visible symlink states.
   *
   * @param error Raw ssh2/SFTP error.
   * @returns Symlink target status.
   */
  private resolveSymlinkTargetStatus(error: unknown): SftpSymlinkTargetStatus {
    if (this.isNoSuchFileError(error)) {
      return 'broken';
    }

    if (this.isPermissionDeniedError(error)) {
      return 'permission-denied';
    }

    return 'unknown';
  }

  /**
   * Detects missing-path failures from ssh2's numeric or string error codes.
   *
   * @param error Raw ssh2/SFTP error.
   * @returns True when the error indicates that the target does not exist.
   */
  private isNoSuchFileError(error: unknown): boolean {
    const code = this.readSftpErrorCode(error);
    if (code === 2 || code === 'ENOENT') {
      return true;
    }

    return this.readSftpErrorMessage(error).includes('no such file');
  }

  /**
   * Detects exclusive-create failures caused by a remote target already existing.
   *
   * @param error Raw ssh2/SFTP error.
   * @returns True when the target already exists.
   */
  private isFileAlreadyExistsError(error: unknown): boolean {
    const code = this.readSftpErrorCode(error);
    if (code === 11 || code === 'EEXIST') {
      return true;
    }

    const message = this.readSftpErrorMessage(error);
    return message.includes('already exists') || message.includes('file exists');
  }

  /**
   * Detects permission failures from ssh2's numeric or string error codes.
   *
   * @param error Raw ssh2/SFTP error.
   * @returns True when the error indicates missing target permissions.
   */
  private isPermissionDeniedError(error: unknown): boolean {
    const code = this.readSftpErrorCode(error);
    if (code === 3 || code === 'EACCES' || code === 'EPERM') {
      return true;
    }

    return this.readSftpErrorMessage(error).includes('permission denied');
  }

  /**
   * Detects transport-level failures that require session eviction and passive reconnect.
   *
   * @param error Raw Node/ssh2 stream error.
   * @returns True when the error indicates an unusable SSH/SFTP transport.
   */
  private isSftpTransportFailure(error: unknown): boolean {
    const code = this.readSftpErrorCode(error);
    if (typeof code === 'string' && SFTP_TRANSPORT_ERROR_CODES.has(code.toUpperCase())) {
      return true;
    }

    const message = this.readSftpErrorMessage(error);
    return (
      message.includes('connection lost') ||
      message.includes('connection closed') ||
      message.includes('channel closed') ||
      message.includes('client is not connected') ||
      message.includes('no response from server') ||
      message.includes('no sftp connection') ||
      message.includes('socket closed')
    );
  }

  /**
   * Reads common error code shapes without trusting third-party error objects.
   *
   * @param error Raw unknown error.
   * @returns Numeric or string code when present.
   */
  private readSftpErrorCode(error: unknown): string | number | undefined {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return undefined;
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
  }

  /**
   * Reads and normalizes an error message for classification.
   *
   * @param error Raw unknown error.
   * @returns Lowercase message or an empty string.
   */
  private readSftpErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message.toLowerCase();
    }

    if (!error || typeof error !== 'object' || !('message' in error)) {
      return '';
    }

    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message.toLowerCase() : '';
  }

  /**
   * Detects ssh2's unhelpful SSH_FX_FAILURE surface used by some servers for overwrite rename.
   *
   * @param error Unknown SFTP error.
   * @returns Whether the error is the generic SFTP failure signal.
   */
  private isGenericSftpFailureError(error: unknown): boolean {
    const message = this.readSftpErrorMessage(error).trim();
    if (message === 'failure') {
      return true;
    }

    if (!isUnknownRecord(error)) {
      return false;
    }

    return error.code === 4 || error.code === '4' || error.code === 'FAILURE';
  }

  /**
   * Resolves upload errors while hiding unhelpful generic SFTP failure text.
   *
   * @param error Unknown upload error.
   * @param fallback Localized fallback message.
   * @returns User-facing upload error.
   */
  private resolveUploadErrorMessage(error: unknown, fallback: string): string {
    if (this.isGenericSftpFailureError(error)) {
      return fallback;
    }

    return this.resolveErrorMessage(error, fallback);
  }

  /**
   * Extracts machine-readable lifecycle metadata from a guarded operation failure.
   *
   * @param error Unknown caught value.
   * @returns Stable internal metadata, or an empty object for ordinary remote failures.
   */
  private resolveOperationFailureMetadata(error: unknown): SftpOperationFailureMetadata {
    if (!isSftpOperationFailure(error)) {
      return {};
    }

    return {
      operationErrorCode: error.code,
      ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
  }

  /**
   * Resolves the most specific non-empty error message available.
   *
   * @param error Unknown caught value.
   * @param fallback Localized fallback message.
   * @returns Error message suitable for the current backend response.
   */
  private resolveErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return fallback;
  }

  private async openSftp(
    server: SshServerWithKeychain,
    options: {
      connectTimeoutSec: number;
      strictHostKey: boolean;
      enableSshCompression: boolean;
      systemProxyRules?: string;
      trustedFingerprintSet: Set<string>;
      t: I18nInstance['t'];
    },
  ): Promise<OpenSftpResult> {
    const client = new Client();
    let presentedFingerprint = '';

    const connectConfig: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: options.connectTimeoutSec * 1000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      algorithms: {
        compress: buildSshCompressionAlgorithms(options.enableSshCompression),
      },
      hostHash: 'sha256',
      hostVerifier: (hashedKey: string) => {
        presentedFingerprint = hashedKey;
        return !options.strictHostKey || options.trustedFingerprintSet.has(hashedKey);
      },
    };

    try {
      if (server.keychain.authType === 'password' || server.keychain.authType === 'both') {
        if (!server.keychain.passwordEncrypted) {
          return {
            type: 'failed',
            message: options.t('errors.ssh.passwordNotConfigured'),
          };
        }

        connectConfig.password = decryptSensitiveValue(server.keychain.passwordEncrypted, this.credentialEncryptionKey);
      }

      if (server.keychain.authType === 'key' || server.keychain.authType === 'both') {
        if (!server.keychain.privateKeyEncrypted) {
          return {
            type: 'failed',
            message: options.t('errors.ssh.privateKeyNotConfigured'),
          };
        }

        connectConfig.privateKey = decryptSensitiveValue(
          server.keychain.privateKeyEncrypted,
          this.credentialEncryptionKey,
        );

        if (server.keychain.privateKeyPassphraseEncrypted) {
          connectConfig.passphrase = decryptSensitiveValue(
            server.keychain.privateKeyPassphraseEncrypted,
            this.credentialEncryptionKey,
          );
        }
      }
    } catch {
      return {
        type: 'failed',
        message: options.t('errors.ssh.decryptCredentialsFailed'),
      };
    }

    let proxyTransport;
    try {
      proxyTransport = await prepareSshProxyTransport(
        this.getDbClient(),
        server,
        options.systemProxyRules,
        options.connectTimeoutSec * 1000,
      );
    } catch (error: unknown) {
      return {
        type: 'failed',
        message: error instanceof Error ? error.message : 'Proxy connection failed.',
        proxyMetadata: error instanceof SshProxyConnectionError ? error.metadata : undefined,
      };
    }

    connectConfig.readyTimeout = proxyTransport.readyTimeoutMs;
    if (proxyTransport.socket) {
      connectConfig.sock = proxyTransport.socket;
    }

    return await new Promise<OpenSftpResult>((resolve) => {
      let settled = false;
      let sftpOpenTimer: NodeJS.Timeout | undefined;

      const settle = (result: OpenSftpResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (sftpOpenTimer) {
          clearTimeout(sftpOpenTimer);
          sftpOpenTimer = undefined;
        }
        resolve(result);
      };

      client.once('ready', () => {
        const subsystemTimeoutMs = Math.max(1, options.connectTimeoutSec * 1000);
        sftpOpenTimer = setTimeout(() => {
          settle({
            type: 'failed',
            message: new SftpOperationFailure(SFTP_OPERATION_TIMEOUT_CODE, 'open-sftp', 'read', subsystemTimeoutMs)
              .message,
            proxyMetadata: proxyTransport.metadata,
          });
          client.destroy();
        }, subsystemTimeoutMs);

        client.sftp((error, sftp) => {
          if (settled) {
            if (sftp) {
              try {
                sftp.destroy();
              } catch (destroyError: unknown) {
                console.warn('[sftp] Failed to destroy a late SFTP subsystem channel.', destroyError);
              }
            }
            return;
          }

          if (error) {
            client.end();
            settle({
              type: 'failed',
              message: error.message,
            });
            return;
          }

          settle({
            type: 'ready',
            client,
            sftp,
            proxyMetadata: proxyTransport.metadata,
          });
        });
      });

      client.once('error', (error) => {
        client.end();

        if (options.strictHostKey && presentedFingerprint && !options.trustedFingerprintSet.has(presentedFingerprint)) {
          settle({
            type: 'host-untrusted',
            fingerprint: presentedFingerprint,
            message: error.message,
            proxyMetadata: proxyTransport.metadata,
          });
          return;
        }

        settle({
          type: 'failed',
          message: error.message,
          proxyMetadata: proxyTransport.metadata,
        });
      });

      client.connect(connectConfig);
    });
  }
}
