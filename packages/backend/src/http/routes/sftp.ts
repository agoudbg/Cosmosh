import crypto from 'node:crypto';

import {
  API_CODES,
  API_PATHS,
  type ApiSftpArchiveCancelResponse,
  type ApiSftpArchiveCapabilitiesResponse,
  type ApiSftpArchiveCompressionLevel,
  type ApiSftpArchiveConflictResolution,
  type ApiSftpArchiveConflictResolutionRequest,
  type ApiSftpArchiveConflictResolutionResponse,
  type ApiSftpArchiveDestinationMode,
  type ApiSftpArchiveFormat,
  type ApiSftpArchiveOperationAcceptedResponse,
  type ApiSftpArchiveOperationData,
  type ApiSftpArchiveOperationRequest,
  type ApiSftpArchiveOperationStatusResponse,
  type ApiSftpBatchOperationResponse,
  type ApiSftpCopyResponse,
  type ApiSftpCreateDirectoryResponse,
  type ApiSftpCreateFileResponse,
  type ApiSftpCreateSessionHostVerificationRequiredResponse,
  type ApiSftpCreateSessionResponse,
  type ApiSftpDeleteResponse,
  type ApiSftpDownloadFileResponse,
  type ApiSftpEntryDetailsResponse,
  type ApiSftpGetTaskResponse,
  type ApiSftpListDirectoryResponse,
  type ApiSftpListTasksResponse,
  type ApiSftpReadFileResponse,
  type ApiSftpRenameResponse,
  type ApiSftpStartTaskRequest,
  type ApiSftpStartTaskResponse,
  type ApiSftpTransferProgressResponse,
  type ApiSftpUploadFileResponse,
  type ApiSftpWriteFileResponse,
  createApiSuccess,
  MAX_SYSTEM_PROXY_RULES_LENGTH,
} from '@cosmosh/api-contract';

import { SftpArchiveError } from '../../sftp/archive-service.js';
import type {
  CreateSftpSessionInput,
  RunSftpBatchOperationInput,
  SftpBatchOperation,
  SftpBatchOperationResult,
  SftpEntryType,
} from '../../sftp/session-service.js';
import {
  buildValidationError,
  isRecord,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  normalizePositiveInteger,
  type ValidationError,
  type ValidationResult,
} from '../../validation-utils.js';
import { buildErrorPayload } from '../errors.js';
import { type BackendHttpApp, type BackendTranslator, getTranslator, translateValidationMessage } from '../i18n.js';
import type { BackendAppContext } from '../types.js';

type NormalizedSftpSessionCreateRequest = Omit<CreateSftpSessionInput, 'locale' | 'requestId'>;

/**
 * Validates a remote filesystem path without trimming meaningful filename bytes.
 * @param value Untrusted HTTP path value.
 * @returns The exact nonempty path, or undefined for invalid input.
 */
const readRemotePath = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && !value.includes('\u0000') ? value : undefined;

type NormalizedSftpPathRequest = {
  path: string;
};

type NormalizedSftpDownloadFileRequest = {
  path: string;
  localPath: string;
  transferId?: string;
};

type NormalizedSftpUploadFileRequest = {
  path: string;
  localPath: string;
  expectedSize?: number;
  expectedModifiedAt?: string;
  overwrite: boolean;
  transferId?: string;
};

type NormalizedSftpWriteFileRequest = {
  path: string;
  content: string;
  expectedSize: number;
  expectedModifiedAt: string;
  overwrite: boolean;
};

type NormalizedSftpRenameRequest = {
  sourcePath: string;
  targetPath: string;
};

type NormalizedSftpDeleteRequest = {
  path: string;
  recursive: boolean;
};

type NormalizedSftpEntryDetailsRequest = {
  paths: string[];
};

type NormalizedSftpBatchOperationRequest = RunSftpBatchOperationInput;

type NormalizedSftpArchiveOperationRequest = ApiSftpArchiveOperationRequest;

type SuccessfulSftpBatchOperationResult = Extract<SftpBatchOperationResult, { type: 'success' }>;

type ApiSftpOperationResponse =
  | ApiSftpCreateDirectoryResponse
  | ApiSftpCreateFileResponse
  | ApiSftpRenameResponse
  | ApiSftpCopyResponse
  | ApiSftpDeleteResponse
  | ApiSftpUploadFileResponse;

const MAX_SFTP_ENTRY_DETAILS_PATHS = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isSftpEntryType = (value: unknown): value is SftpEntryType => {
  return value === 'directory' || value === 'file' || value === 'symlink' || value === 'other';
};

const isSftpBatchOperation = (value: unknown): value is SftpBatchOperation => {
  return value === 'copy' || value === 'move' || value === 'delete' || value === 'link';
};

const isSftpArchiveFormat = (value: unknown): value is ApiSftpArchiveFormat => {
  return ['tar', 'tar-gzip', 'zip', 'tar-xz', 'tar-bzip2', '7z'].includes(String(value));
};

const isSftpArchiveCompressionLevel = (value: unknown): value is ApiSftpArchiveCompressionLevel => {
  return ['store', 'fast', 'standard', 'maximum'].includes(String(value));
};

const isSftpArchiveDestinationMode = (value: unknown): value is ApiSftpArchiveDestinationMode => {
  return ['smart', 'current-directory', 'archive-name-directory'].includes(String(value));
};

const isSftpArchiveConflictResolution = (value: unknown): value is ApiSftpArchiveConflictResolution => {
  return ['overwrite', 'keep-both', 'cancel'].includes(String(value));
};

/**
 * Parses and validates SFTP session creation payload.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized request or validation error.
 */
const parseCreateSftpSessionRequest = (payload: unknown): ValidationResult<NormalizedSftpSessionCreateRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const serverId = normalizeOptionalString(payload.serverId);
  if (!serverId) {
    return {
      error: buildValidationError('errors.validation.serverIdRequired', 'serverId is required.'),
    };
  }

  const connectTimeoutSec =
    typeof payload.connectTimeoutSec === 'number' ? payload.connectTimeoutSec : Number(payload.connectTimeoutSec ?? 45);
  if (!Number.isInteger(connectTimeoutSec) || connectTimeoutSec < 5 || connectTimeoutSec > 180) {
    return {
      error: buildValidationError(
        'errors.validation.connectTimeoutRange',
        'connectTimeoutSec must be an integer between 5 and 180.',
      ),
    };
  }

  const strictHostKey = normalizeOptionalBoolean(payload.strictHostKey);
  if (payload.strictHostKey !== undefined && strictHostKey === undefined) {
    return {
      error: buildValidationError('errors.validation.strictHostKeyType', 'strictHostKey must be a boolean value.'),
    };
  }

  const initialPath =
    payload.initialPath === undefined || payload.initialPath === '' ? '.' : readRemotePath(payload.initialPath);
  if (!initialPath) return { error: buildValidationError('errors.sftp.pathRequired', 'path is required.') };
  const systemProxyRules = normalizeOptionalString(payload.systemProxyRules);
  if (
    payload.systemProxyRules !== undefined &&
    (!systemProxyRules || systemProxyRules.length > MAX_SYSTEM_PROXY_RULES_LENGTH)
  ) {
    return {
      error: buildValidationError(
        'errors.validation.systemProxyRulesLength',
        `systemProxyRules must be ${MAX_SYSTEM_PROXY_RULES_LENGTH} characters or fewer.`,
      ),
    };
  }

  const value: NormalizedSftpSessionCreateRequest = {
    serverId,
    connectTimeoutSec,
    initialPath,
    systemProxyRules,
  };

  if (strictHostKey !== undefined) {
    value.strictHostKey = strictHostKey;
  }

  return {
    value,
  };
};

/**
 * Parses and validates a payload that contains one SFTP path.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized request or validation error.
 */
const parseSftpPathRequest = (payload: unknown): ValidationResult<NormalizedSftpPathRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const requestedPath = readRemotePath(payload.path);
  if (!requestedPath) {
    return {
      error: buildValidationError('errors.sftp.pathRequired', 'path is required.'),
    };
  }

  return {
    value: {
      path: requestedPath,
    },
  };
};

/**
 * Parses and validates one SFTP file download payload.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized download request or validation error.
 */
const parseSftpDownloadFileRequest = (payload: unknown): ValidationResult<NormalizedSftpDownloadFileRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const requestedPath = readRemotePath(payload.path);
  if (!requestedPath) {
    return {
      error: buildValidationError('errors.sftp.pathRequired', 'path is required.'),
    };
  }

  const localPath = normalizeOptionalString(payload.localPath);
  if (!localPath) {
    return {
      error: buildValidationError('errors.sftp.localPathRequired', 'localPath is required.'),
    };
  }

  const transferId = normalizeOptionalString(payload.transferId);
  if (payload.transferId !== undefined && (!transferId || !UUID_PATTERN.test(transferId))) {
    return {
      error: buildValidationError('errors.validation.invalidPayload', 'transferId must be a UUID.'),
    };
  }

  return {
    value: {
      path: requestedPath,
      localPath,
      ...(transferId ? { transferId } : {}),
    },
  };
};

/**
 * Parses and validates one SFTP file upload payload.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized upload request or validation error.
 */
const parseSftpUploadFileRequest = (payload: unknown): ValidationResult<NormalizedSftpUploadFileRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const requestedPath = readRemotePath(payload.path);
  if (!requestedPath) {
    return {
      error: buildValidationError('errors.sftp.pathRequired', 'path is required.'),
    };
  }

  const localPath = normalizeOptionalString(payload.localPath);
  if (!localPath) {
    return {
      error: buildValidationError('errors.sftp.localPathRequired', 'localPath is required.'),
    };
  }

  const transferId = normalizeOptionalString(payload.transferId);
  if (payload.transferId !== undefined && (!transferId || !UUID_PATTERN.test(transferId))) {
    return {
      error: buildValidationError('errors.validation.invalidPayload', 'transferId must be a UUID.'),
    };
  }

  const hasExpectedSize = payload.expectedSize !== undefined;
  const hasExpectedModifiedAt = payload.expectedModifiedAt !== undefined;
  if (hasExpectedSize !== hasExpectedModifiedAt) {
    return {
      error: buildValidationError(
        'errors.validation.invalidPayload',
        'expectedSize and expectedModifiedAt must be provided together.',
      ),
    };
  }

  const expectedSize = hasExpectedSize ? payload.expectedSize : undefined;
  if (
    expectedSize !== undefined &&
    (typeof expectedSize !== 'number' || !Number.isSafeInteger(expectedSize) || expectedSize < 0)
  ) {
    return {
      error: buildValidationError('errors.sftp.expectedSizeRequired', 'expectedSize must be a non-negative integer.'),
    };
  }

  const expectedModifiedAt = hasExpectedModifiedAt ? normalizeOptionalString(payload.expectedModifiedAt) : undefined;
  if (hasExpectedModifiedAt && (!expectedModifiedAt || Number.isNaN(Date.parse(expectedModifiedAt)))) {
    return {
      error: buildValidationError('errors.sftp.expectedModifiedAtRequired', 'expectedModifiedAt must be a date-time.'),
    };
  }

  if (payload.overwrite !== undefined && normalizeOptionalBoolean(payload.overwrite) === undefined) {
    return {
      error: buildValidationError('errors.validation.invalidPayload', 'overwrite must be a boolean when provided.'),
    };
  }

  return {
    value: {
      path: requestedPath,
      localPath,
      expectedSize,
      expectedModifiedAt,
      overwrite: payload.overwrite === true,
      ...(transferId ? { transferId } : {}),
    },
  };
};

/**
 * Parses and validates one SFTP text file write payload.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized write request or validation error.
 */
const parseSftpWriteFileRequest = (payload: unknown): ValidationResult<NormalizedSftpWriteFileRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const requestedPath = readRemotePath(payload.path);
  if (!requestedPath) {
    return {
      error: buildValidationError('errors.sftp.pathRequired', 'path is required.'),
    };
  }

  if (typeof payload.content !== 'string') {
    return {
      error: buildValidationError('errors.validation.invalidPayload', 'content must be a string.'),
    };
  }

  const expectedSize = Number(payload.expectedSize);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    return {
      error: buildValidationError('errors.sftp.expectedSizeRequired', 'expectedSize must be a non-negative integer.'),
    };
  }

  const expectedModifiedAt = normalizeOptionalString(payload.expectedModifiedAt);
  if (!expectedModifiedAt || Number.isNaN(Date.parse(expectedModifiedAt))) {
    return {
      error: buildValidationError('errors.sftp.expectedModifiedAtRequired', 'expectedModifiedAt must be a date-time.'),
    };
  }

  if (payload.overwrite !== undefined && normalizeOptionalBoolean(payload.overwrite) === undefined) {
    return {
      error: buildValidationError('errors.validation.invalidPayload', 'overwrite must be a boolean when provided.'),
    };
  }

  return {
    value: {
      path: requestedPath,
      content: payload.content,
      expectedSize,
      expectedModifiedAt,
      overwrite: payload.overwrite === true,
    },
  };
};

/**
 * Parses source/target path payloads for SFTP copy and rename operations.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized source/target request or validation error.
 */
const parseSftpSourceTargetRequest = (payload: unknown): ValidationResult<NormalizedSftpRenameRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const sourcePath = readRemotePath(payload.sourcePath);
  const targetPath = readRemotePath(payload.targetPath);
  if (!sourcePath || !targetPath) {
    return {
      error: buildValidationError('errors.sftp.sourceTargetRequired', 'sourcePath and targetPath are required.'),
    };
  }

  return {
    value: {
      sourcePath,
      targetPath,
    },
  };
};

/**
 * Parses SFTP delete payloads.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized delete request or validation error.
 */
const parseSftpDeleteRequest = (payload: unknown): ValidationResult<NormalizedSftpDeleteRequest> => {
  const parsedPath = parseSftpPathRequest(payload);
  if (!parsedPath.value) {
    return parsedPath as ValidationResult<NormalizedSftpDeleteRequest>;
  }

  const recursive = isRecord(payload) && typeof payload.recursive === 'boolean' ? payload.recursive : true;
  return {
    value: {
      path: parsedPath.value.path,
      recursive,
    },
  };
};

/**
 * Parses SFTP entry details payloads.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized details request or validation error.
 */
const parseSftpEntryDetailsRequest = (payload: unknown): ValidationResult<NormalizedSftpEntryDetailsRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  if (!Array.isArray(payload.paths) || payload.paths.length === 0) {
    return {
      error: buildValidationError('errors.sftp.entryDetailsPathsRequired', 'paths must contain at least one item.'),
    };
  }

  if (payload.paths.length > MAX_SFTP_ENTRY_DETAILS_PATHS) {
    return {
      error: buildValidationError(
        'errors.sftp.entryDetailsPathLimit',
        `paths must contain no more than ${MAX_SFTP_ENTRY_DETAILS_PATHS} items.`,
        { limit: MAX_SFTP_ENTRY_DETAILS_PATHS },
      ),
    };
  }

  const paths: string[] = [];
  for (const pathValue of payload.paths) {
    const entryPath = readRemotePath(pathValue);
    if (!entryPath) {
      return {
        error: buildValidationError('errors.sftp.pathRequired', 'path is required.'),
      };
    }

    paths.push(entryPath);
  }

  return {
    value: {
      paths,
    },
  };
};

/**
 * Parses SFTP batch operation payloads.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized batch operation request or validation error.
 */
const parseSftpBatchOperationRequest = (payload: unknown): ValidationResult<NormalizedSftpBatchOperationRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  if (!isSftpBatchOperation(payload.operation)) {
    return {
      error: buildValidationError(
        'errors.sftp.batchOperationRequired',
        'operation must be copy, move, delete, or link.',
      ),
    };
  }

  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    return {
      error: buildValidationError('errors.sftp.batchEntriesRequired', 'entries must contain at least one item.'),
    };
  }

  const entries: RunSftpBatchOperationInput['entries'] = [];
  for (const entry of payload.entries) {
    if (!isRecord(entry)) {
      return {
        error: buildValidationError('errors.sftp.batchEntriesRequired', 'entries must contain valid item objects.'),
      };
    }

    const entryPath = readRemotePath(entry.path);
    if (!entryPath) {
      return {
        error: buildValidationError('errors.sftp.pathRequired', 'path is required.'),
      };
    }

    if (!isSftpEntryType(entry.type)) {
      return {
        error: buildValidationError('errors.sftp.entryTypeRequired', 'entry type is required.'),
      };
    }

    entries.push({
      path: entryPath,
      type: entry.type,
    });
  }

  const targetDirectoryPath = readRemotePath(payload.targetDirectoryPath);
  if (
    (payload.operation === 'copy' || payload.operation === 'move' || payload.operation === 'link') &&
    !targetDirectoryPath
  ) {
    return {
      error: buildValidationError(
        'errors.sftp.batchTargetRequired',
        'targetDirectoryPath is required for copy, move, and link batch operations.',
      ),
    };
  }

  const value: NormalizedSftpBatchOperationRequest = {
    operation: payload.operation,
    entries,
  };

  if (targetDirectoryPath) {
    value.targetDirectoryPath = targetDirectoryPath;
  }

  return {
    value,
  };
};

/**
 * Parses one asynchronous SFTP task descriptor through the existing operation validators.
 *
 * Transfer tasks require a caller-generated transfer id so progress and terminal state share one
 * correlation key. Main remains responsible for authorizing exact local download paths.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized task descriptor or validation error.
 */
const parseSftpTaskStartRequest = (payload: unknown): ValidationResult<ApiSftpStartTaskRequest> => {
  if (!isRecord(payload) || !isRecord(payload.payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Task payload must be a JSON object.'),
    };
  }

  switch (payload.operation) {
    case 'create-file':
    case 'create-directory': {
      const parsed = parseSftpPathRequest(payload.payload);
      return parsed.value
        ? {
            value: {
              operation: payload.operation,
              payload: parsed.value,
            },
          }
        : { error: parsed.error };
    }
    case 'rename': {
      const parsed = parseSftpSourceTargetRequest(payload.payload);
      return parsed.value
        ? {
            value: {
              operation: 'rename',
              payload: parsed.value,
            },
          }
        : { error: parsed.error };
    }
    case 'upload': {
      const parsed = parseSftpUploadFileRequest(payload.payload);
      if (!parsed.value) {
        return { error: parsed.error };
      }
      if (!parsed.value.transferId) {
        return {
          error: buildValidationError(
            'errors.validation.invalidPayload',
            'transferId is required for asynchronous uploads.',
          ),
        };
      }
      return {
        value: {
          operation: 'upload',
          payload: {
            ...parsed.value,
            transferId: parsed.value.transferId,
          },
        },
      };
    }
    case 'download': {
      const parsed = parseSftpDownloadFileRequest(payload.payload);
      if (!parsed.value) {
        return { error: parsed.error };
      }
      if (!parsed.value.transferId) {
        return {
          error: buildValidationError(
            'errors.validation.invalidPayload',
            'transferId is required for asynchronous downloads.',
          ),
        };
      }
      return {
        value: {
          operation: 'download',
          payload: {
            ...parsed.value,
            transferId: parsed.value.transferId,
          },
        },
      };
    }
    case 'batch': {
      const parsed = parseSftpBatchOperationRequest(payload.payload);
      return parsed.value
        ? {
            value: {
              operation: 'batch',
              payload: parsed.value,
            },
          }
        : { error: parsed.error };
    }
    default:
      return {
        error: buildValidationError(
          'errors.validation.invalidPayload',
          'operation must be create-file, create-directory, rename, upload, download, or batch.',
        ),
      };
  }
};

/**
 * Parses a discriminated archive operation without accepting tool flags or shell fragments.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized archive request or validation error.
 */
const parseSftpArchiveOperationRequest = (
  payload: unknown,
): ValidationResult<NormalizedSftpArchiveOperationRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  if (payload.type === 'compress') {
    const targetDirectoryPath = normalizeOptionalString(payload.targetDirectoryPath);
    const archiveName = normalizeOptionalString(payload.archiveName);
    if (!Array.isArray(payload.sourcePaths) || payload.sourcePaths.length === 0) {
      return {
        error: buildValidationError(
          'errors.sftp.archiveSourcesRequired',
          'sourcePaths must contain at least one item.',
        ),
      };
    }
    const sourcePaths = payload.sourcePaths.map(normalizeOptionalString);
    if (sourcePaths.some((sourcePath) => !sourcePath)) {
      return { error: buildValidationError('errors.sftp.pathRequired', 'path is required.') };
    }
    if (!targetDirectoryPath || !archiveName) {
      return {
        error: buildValidationError(
          'errors.sftp.archiveTargetRequired',
          'targetDirectoryPath and archiveName are required.',
        ),
      };
    }
    if (!isSftpArchiveFormat(payload.format) || !isSftpArchiveCompressionLevel(payload.compressionLevel)) {
      return {
        error: buildValidationError(
          'errors.sftp.archiveOptionsInvalid',
          'Archive format or compression level is invalid.',
        ),
      };
    }
    return {
      value: {
        type: 'compress',
        sourcePaths: sourcePaths as string[],
        targetDirectoryPath,
        archiveName,
        format: payload.format,
        compressionLevel: payload.compressionLevel,
      },
    };
  }

  if (payload.type === 'extract') {
    const archivePath = normalizeOptionalString(payload.archivePath);
    const targetDirectoryPath = normalizeOptionalString(payload.targetDirectoryPath);
    if (!archivePath || !targetDirectoryPath || !isSftpArchiveDestinationMode(payload.destinationMode)) {
      return {
        error: buildValidationError(
          'errors.sftp.archiveExtractOptionsInvalid',
          'archivePath, targetDirectoryPath, and destinationMode are required.',
        ),
      };
    }
    return {
      value: {
        type: 'extract',
        archivePath,
        targetDirectoryPath,
        destinationMode: payload.destinationMode,
      },
    };
  }

  return {
    error: buildValidationError('errors.sftp.archiveTypeInvalid', 'type must be compress or extract.'),
  };
};

/**
 * Parses one task-wide conflict decision.
 *
 * @param payload Raw HTTP JSON payload.
 * @returns Normalized resolution request or validation error.
 */
const parseSftpArchiveConflictResolutionRequest = (
  payload: unknown,
): ValidationResult<ApiSftpArchiveConflictResolutionRequest> => {
  if (!isRecord(payload) || !isSftpArchiveConflictResolution(payload.resolution)) {
    return {
      error: buildValidationError(
        'errors.sftp.archiveConflictResolutionInvalid',
        'resolution must be overwrite, keep-both, or cancel.',
      ),
    };
  }
  return { value: { resolution: payload.resolution } };
};

/** Maps stable archive errors to the public HTTP status family. */
const getArchiveErrorStatus = (error: SftpArchiveError): 400 | 404 | 409 => {
  if (error.code === API_CODES.sftpArchiveOperationNotFound) return 404;
  if (
    error.code === API_CODES.sftpArchiveBusy ||
    error.code === API_CODES.sftpArchiveTargetExists ||
    error.code === API_CODES.sftpArchiveCancelFailed
  ) {
    return 409;
  }
  return 400;
};

/** Returns a localized public summary for one stable archive error code. */
const translateArchiveError = (t: BackendTranslator, code: string, fallback: string): string => {
  switch (code) {
    case API_CODES.sftpArchiveUnsupported:
      return t('errors.sftp.archiveUnsupported');
    case API_CODES.sftpArchiveBusy:
      return t('errors.sftp.archiveBusy');
    case API_CODES.sftpArchiveTargetExists:
      return t('errors.sftp.archiveTargetExists');
    case API_CODES.sftpArchiveUnsafeEntry:
      return t('errors.sftp.archiveUnsafeEntry');
    case API_CODES.sftpArchiveOperationNotFound:
      return t('errors.sftp.archiveOperationNotFound');
    case API_CODES.sftpArchiveOperationFailed:
      return t('errors.sftp.archiveOperationFailed');
    case API_CODES.sftpArchiveTimeout:
      return t('errors.sftp.archiveTimeout');
    case API_CODES.sftpArchiveCancelFailed:
      return t('errors.sftp.archiveCancelFailed');
    case API_CODES.sftpValidationFailed:
      return t('errors.sftp.archiveValidationFailed');
    default:
      return fallback;
  }
};

/** Localizes terminal task errors without exposing command output or staging paths. */
const localizeArchiveOperation = (
  t: BackendTranslator,
  operation: ApiSftpArchiveOperationData,
): ApiSftpArchiveOperationData => {
  if (!operation.errorCode || !operation.errorMessage) return operation;
  return {
    ...operation,
    errorMessage: translateArchiveError(t, operation.errorCode, operation.errorMessage),
  };
};

/** Normalizes unexpected archive route failures into a stable public envelope. */
const buildArchiveErrorResponse = (
  t: BackendTranslator,
  error: unknown,
): { payload: ReturnType<typeof buildErrorPayload>; status: 400 | 404 | 409 } => {
  const archiveError =
    error instanceof SftpArchiveError
      ? error
      : new SftpArchiveError(API_CODES.sftpArchiveOperationFailed, 'The archive operation failed.');
  return {
    payload: buildErrorPayload(archiveError.code, translateArchiveError(t, archiveError.code, archiveError.message)),
    status: getArchiveErrorStatus(archiveError),
  };
};

const buildValidationFailureResponse = (t: BackendTranslator, error?: ValidationError) => {
  return buildErrorPayload(
    API_CODES.sftpValidationFailed,
    error ? t(error.i18nKey, error.params) : t('errors.validation.invalidPayload'),
  );
};

const buildOperationFailureResponse = (t: BackendTranslator, reason: string) => {
  return buildErrorPayload(
    API_CODES.sftpOperationFailed,
    translateValidationMessage(
      reason,
      t('errors.sftp.operationFailed', { reason }),
      t('errors.sftp.operationFailedNoReason'),
    ),
  );
};

const buildSftpOperationSuccess = (
  code: typeof API_CODES.sftpOperationOk,
  message: string,
  data: {
    sessionId: string;
    path: string;
    targetPath?: string;
  },
): ApiSftpOperationResponse => {
  return createApiSuccess({
    code,
    message,
    data,
  });
};

const buildSftpBatchOperationSuccess = (
  t: BackendTranslator,
  data: SuccessfulSftpBatchOperationResult,
): ApiSftpBatchOperationResponse => {
  return createApiSuccess({
    code: API_CODES.sftpOperationOk,
    message: t('success.sftp.batchOperationCompleted'),
    data: {
      sessionId: data.sessionId,
      operation: data.operation,
      totalCount: data.totalCount,
      completedCount: data.completedCount,
      failedCount: data.failedCount,
      skippedCount: data.skippedCount,
      stoppedOnFailure: data.stoppedOnFailure,
      results: data.results,
    },
  });
};

/**
 * Registers a POST SFTP path operation route with shared validation/error mapping.
 *
 * @param app Backend HTTP app.
 * @param routePath API path template with `{sessionId}` token.
 * @param parsePayload Payload parser.
 * @param successMessage Success message resolver.
 * @param runOperation Service operation callback.
 * @returns void.
 */
const registerSftpPathOperationRoute = <TRequest>(
  app: BackendHttpApp,
  routePath: string,
  parsePayload: (payload: unknown) => ValidationResult<TRequest>,
  successMessage: (t: BackendTranslator) => string,
  runOperation: (
    sessionId: string,
    request: TRequest,
  ) => Promise<
    | {
        type: 'success';
        sessionId: string;
        path: string;
        targetPath?: string;
      }
    | { type: 'not-found' }
    | { type: 'failed'; message: string }
  >,
): void => {
  app.post(routePath.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parsePayload(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = await runOperation(sessionId, parsed.value);
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    return c.json(buildSftpOperationSuccess(API_CODES.sftpOperationOk, successMessage(t), result));
  });
};

/**
 * Registers SFTP browser session routes.
 *
 * @param app Backend HTTP app.
 * @param context Runtime services injected by backend bootstrap.
 * @returns void.
 */
export const registerSftpRoutes = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.post(API_PATHS.sftpCreateSession, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const parsed = parseCreateSftpSessionRequest(await c.req.json().catch(() => undefined));

    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sftpValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    const result = await context.sftpSessionService.createSession({
      ...parsed.value,
      locale: c.get('locale'),
      requestId,
    });

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.ssh.serverNotFound')), 404);
    }

    if (result.type === 'host-untrusted') {
      const payload: ApiSftpCreateSessionHostVerificationRequiredResponse = {
        success: false,
        code: API_CODES.sshHostUntrusted,
        message: t('errors.ssh.hostFingerprintUntrusted'),
        requestId,
        timestamp: new Date().toISOString(),
        data: {
          serverId: result.serverId,
          host: result.host,
          port: result.port,
          algorithm: result.algorithm,
          fingerprint: result.fingerprint,
        },
      };

      return c.json(payload, 409);
    }

    if (result.type === 'failed') {
      return c.json(
        buildErrorPayload(
          API_CODES.sftpOperationFailed,
          translateValidationMessage(
            result.message,
            t('errors.sftp.sessionCreateFailed', { reason: result.message }),
            t('errors.sftp.sessionCreateFailedNoReason'),
          ),
        ),
        400,
      );
    }

    const payload: ApiSftpCreateSessionResponse = createApiSuccess({
      code: API_CODES.sftpSessionCreateOk,
      message: t('success.sftp.sessionCreated'),
      requestId,
      data: {
        sessionId: result.sessionId,
        serverId: result.serverId,
        initialPath: result.initialPath,
        currentPath: result.currentPath,
        readOnly: false,
      },
    });

    return c.json(payload);
  });

  app.get(API_PATHS.sftpListDirectory.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    const requestedPath = c.req.query('path');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const result = await context.sftpSessionService.listDirectory(sessionId, requestedPath);

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      return c.json(
        buildErrorPayload(
          API_CODES.sftpOperationFailed,
          translateValidationMessage(
            result.message,
            t('errors.sftp.directoryListFailed', { reason: result.message }),
            t('errors.sftp.directoryListFailedNoReason'),
          ),
        ),
        400,
      );
    }

    const payload: ApiSftpListDirectoryResponse = createApiSuccess({
      code: API_CODES.sftpDirectoryListOk,
      message: t('success.sftp.directoryListed'),
      data: {
        sessionId: result.sessionId,
        path: result.path,
        parentPath: result.parentPath,
        entries: result.entries,
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sftpGetEntryDetails.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parseSftpEntryDetailsRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = await context.sftpSessionService.getEntryDetails(sessionId, parsed.value.paths);
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    const payload: ApiSftpEntryDetailsResponse = createApiSuccess({
      code: API_CODES.sftpEntryDetailsOk,
      message: t('success.sftp.entryDetailsFetched'),
      data: {
        sessionId: result.sessionId,
        requestedCount: result.requestedCount,
        entries: result.entries,
      },
    });

    return c.json(payload);
  });

  app.get(API_PATHS.sftpReadFile.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    const requestedPath = c.req.query('path');
    const maxBytes = normalizePositiveInteger(c.req.query('maxBytes'));

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    if (!requestedPath) {
      return c.json(
        buildValidationFailureResponse(t, buildValidationError('errors.sftp.pathRequired', 'path is required.')),
        400,
      );
    }

    const result = await context.sftpSessionService.readFilePreview(sessionId, requestedPath, maxBytes);
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    const payload: ApiSftpReadFileResponse = createApiSuccess({
      code: API_CODES.sftpFileReadOk,
      message: t('success.sftp.fileRead'),
      data: {
        sessionId: result.sessionId,
        path: result.path,
        encoding: 'utf8',
        content: result.content,
        size: result.size,
        truncated: result.truncated,
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sftpWriteFile.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parseSftpWriteFileRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = await context.sftpSessionService.writeTextFile(
      sessionId,
      parsed.value.path,
      parsed.value.content,
      {
        size: parsed.value.expectedSize,
        modifiedAt: parsed.value.expectedModifiedAt,
      },
      {
        overwrite: parsed.value.overwrite,
      },
    );
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      if (result.reason === 'remote-conflict') {
        return c.json(buildErrorPayload(API_CODES.sftpUploadConflict, result.message), 409);
      }

      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    const payload: ApiSftpWriteFileResponse = createApiSuccess({
      code: API_CODES.sftpOperationOk,
      message: t('success.sftp.fileWritten'),
      data: {
        sessionId: result.sessionId,
        path: result.path,
        ...(result.size !== undefined ? { size: result.size } : {}),
        ...(result.modifiedAt ? { modifiedAt: result.modifiedAt } : {}),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sftpDownloadFile.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parseSftpDownloadFileRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = await context.sftpSessionService.downloadFile(
      sessionId,
      parsed.value.path,
      parsed.value.localPath,
      parsed.value.transferId,
    );
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    const payload: ApiSftpDownloadFileResponse = createApiSuccess({
      code: API_CODES.sftpOperationOk,
      message: t('success.sftp.fileDownloaded'),
      data: {
        sessionId: result.sessionId,
        path: result.path,
        localPath: result.localPath,
        size: result.size,
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sftpUploadFile.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parseSftpUploadFileRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = await context.sftpSessionService.uploadFile(
      sessionId,
      parsed.value.path,
      parsed.value.localPath,
      parsed.value.expectedSize !== undefined && parsed.value.expectedModifiedAt
        ? {
            size: parsed.value.expectedSize,
            modifiedAt: parsed.value.expectedModifiedAt,
          }
        : undefined,
      {
        overwrite: parsed.value.overwrite,
        transferId: parsed.value.transferId,
      },
    );
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      if (result.reason === 'remote-conflict') {
        return c.json(buildErrorPayload(API_CODES.sftpUploadConflict, result.message), 409);
      }

      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    const payload: ApiSftpUploadFileResponse = createApiSuccess({
      code: API_CODES.sftpOperationOk,
      message: t('success.sftp.fileUploaded'),
      data: {
        sessionId: result.sessionId,
        path: result.path,
        ...(result.targetPath ? { targetPath: result.targetPath } : {}),
        ...(result.size !== undefined ? { size: result.size } : {}),
        ...(result.modifiedAt ? { modifiedAt: result.modifiedAt } : {}),
      },
    });

    return c.json(payload);
  });

  app.get(API_PATHS.sftpGetTransferProgress.replace('{transferId}', ':transferId'), (c) => {
    const t = getTranslator(c);
    const transferId = c.req.param('transferId')?.trim();
    if (!transferId || !UUID_PATTERN.test(transferId)) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const progress = context.sftpSessionService.getTransferProgress(transferId);
    if (!progress) {
      return c.json(buildErrorPayload(API_CODES.sftpTransferNotFound, t('errors.sftp.transferNotFound')), 404);
    }

    const payload: ApiSftpTransferProgressResponse = createApiSuccess({
      code: API_CODES.sftpTransferProgressOk,
      message: t('success.sftp.transferProgressRead'),
      data: progress,
    });
    return c.json(payload);
  });

  registerSftpPathOperationRoute(
    app,
    API_PATHS.sftpCreateDirectory,
    parseSftpPathRequest,
    (t) => t('success.sftp.directoryCreated'),
    (sessionId, request) => context.sftpSessionService.createDirectory(sessionId, request.path),
  );

  registerSftpPathOperationRoute(
    app,
    API_PATHS.sftpCreateFile,
    parseSftpPathRequest,
    (t) => t('success.sftp.fileCreated'),
    (sessionId, request) => context.sftpSessionService.createFile(sessionId, request.path),
  );

  registerSftpPathOperationRoute(
    app,
    API_PATHS.sftpRenameEntry,
    parseSftpSourceTargetRequest,
    (t) => t('success.sftp.entryRenamed'),
    (sessionId, request) => context.sftpSessionService.renameEntry(sessionId, request.sourcePath, request.targetPath),
  );

  registerSftpPathOperationRoute(
    app,
    API_PATHS.sftpCopyEntry,
    parseSftpSourceTargetRequest,
    (t) => t('success.sftp.entryCopied'),
    (sessionId, request) => context.sftpSessionService.copyEntry(sessionId, request.sourcePath, request.targetPath),
  );

  registerSftpPathOperationRoute(
    app,
    API_PATHS.sftpDeleteEntry,
    parseSftpDeleteRequest,
    (t) => t('success.sftp.entryDeleted'),
    (sessionId, request) => context.sftpSessionService.deleteEntry(sessionId, request.path, request.recursive),
  );

  app.post(API_PATHS.sftpBatchOperation.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parseSftpBatchOperationRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = await context.sftpSessionService.runBatchOperation(sessionId, parsed.value);
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    if (result.type === 'failed') {
      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    return c.json(buildSftpBatchOperationSuccess(t, result));
  });

  app.post(API_PATHS.sftpStartTask.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const parsed = parseSftpTaskStartRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    }

    const result = context.sftpSessionService.startTask(sessionId, parsed.value);
    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }
    if (result.type === 'failed') {
      return c.json(buildOperationFailureResponse(t, result.message), 400);
    }

    const payload: ApiSftpStartTaskResponse = createApiSuccess({
      code: API_CODES.sftpTaskAccepted,
      message: t('success.sftp.taskAccepted'),
      data: result.task,
    });
    return c.json(payload, 202);
  });

  app.get(API_PATHS.sftpListTasks.replace('{sessionId}', ':sessionId'), (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }

    const tasks = context.sftpSessionService.listTasks(sessionId);
    if (!tasks) {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    const payload: ApiSftpListTasksResponse = createApiSuccess({
      code: API_CODES.sftpTaskListOk,
      message: t('success.sftp.taskListLoaded'),
      data: {
        sessionId,
        items: tasks,
      },
    });
    return c.json(payload);
  });

  app.get(API_PATHS.sftpGetTask.replace('{sessionId}', ':sessionId').replace('{taskId}', ':taskId'), (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    const taskId = c.req.param('taskId');
    if (!sessionId || !taskId || !UUID_PATTERN.test(taskId)) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const task = context.sftpSessionService.getTask(sessionId, taskId);
    if (!task) {
      return c.json(buildErrorPayload(API_CODES.sftpTaskNotFound, t('errors.sftp.taskNotFound')), 404);
    }

    const payload: ApiSftpGetTaskResponse = createApiSuccess({
      code: API_CODES.sftpTaskStatusOk,
      message: t('success.sftp.taskStatusLoaded'),
      data: task,
    });
    return c.json(payload);
  });

  app.get(API_PATHS.sftpGetArchiveCapabilities.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }
    try {
      const capabilities = await context.sftpSessionService.getArchiveCapabilities(sessionId);
      if (!capabilities) {
        return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
      }
      const payload: ApiSftpArchiveCapabilitiesResponse = createApiSuccess({
        code: API_CODES.sftpArchiveCapabilitiesOk,
        message: t('success.sftp.archiveCapabilitiesLoaded'),
        data: capabilities,
      });
      return c.json(payload);
    } catch (error: unknown) {
      const failure = buildArchiveErrorResponse(t, error);
      return c.json(failure.payload, failure.status);
    }
  });

  app.post(API_PATHS.sftpStartArchiveOperation.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    if (!sessionId) {
      return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.sftp.sessionIdRequired')), 400);
    }
    const parsed = parseSftpArchiveOperationRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) return c.json(buildValidationFailureResponse(t, parsed.error), 400);
    try {
      const operation = await context.sftpSessionService.startArchiveOperation(sessionId, parsed.value);
      if (!operation) {
        return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
      }
      const payload: ApiSftpArchiveOperationAcceptedResponse = createApiSuccess({
        code: API_CODES.sftpArchiveOperationAccepted,
        message: t('success.sftp.archiveOperationAccepted'),
        data: operation,
      });
      return c.json(payload, 202);
    } catch (error: unknown) {
      const failure = buildArchiveErrorResponse(t, error);
      return c.json(failure.payload, failure.status);
    }
  });

  app.get(
    API_PATHS.sftpGetArchiveOperation.replace('{sessionId}', ':sessionId').replace('{operationId}', ':operationId'),
    (c) => {
      const t = getTranslator(c);
      const sessionId = c.req.param('sessionId');
      const operationId = c.req.param('operationId');
      if (!sessionId || !operationId || !UUID_PATTERN.test(operationId)) {
        return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.validation.invalidPayload')), 400);
      }
      try {
        const operation = context.sftpSessionService.getArchiveOperation(sessionId, operationId);
        if (!operation) {
          return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
        }
        const payload: ApiSftpArchiveOperationStatusResponse = createApiSuccess({
          code: API_CODES.sftpArchiveOperationStatusOk,
          message: t('success.sftp.archiveOperationStatusLoaded'),
          data: localizeArchiveOperation(t, operation),
        });
        return c.json(payload);
      } catch (error: unknown) {
        const failure = buildArchiveErrorResponse(t, error);
        return c.json(failure.payload, failure.status);
      }
    },
  );

  app.post(
    API_PATHS.sftpResolveArchiveConflict.replace('{sessionId}', ':sessionId').replace('{operationId}', ':operationId'),
    async (c) => {
      const t = getTranslator(c);
      const sessionId = c.req.param('sessionId');
      const operationId = c.req.param('operationId');
      if (!sessionId || !operationId || !UUID_PATTERN.test(operationId)) {
        return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.validation.invalidPayload')), 400);
      }
      const parsed = parseSftpArchiveConflictResolutionRequest(await c.req.json().catch(() => undefined));
      if (!parsed.value) return c.json(buildValidationFailureResponse(t, parsed.error), 400);
      try {
        const operation = context.sftpSessionService.resolveArchiveConflict(
          sessionId,
          operationId,
          parsed.value.resolution,
        );
        if (!operation) {
          return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
        }
        const payload: ApiSftpArchiveConflictResolutionResponse = createApiSuccess({
          code: API_CODES.sftpArchiveOperationStatusOk,
          message: t('success.sftp.archiveConflictResolved'),
          data: localizeArchiveOperation(t, operation),
        });
        return c.json(payload);
      } catch (error: unknown) {
        const failure = buildArchiveErrorResponse(t, error);
        return c.json(failure.payload, failure.status);
      }
    },
  );

  app.delete(
    API_PATHS.sftpCancelArchiveOperation.replace('{sessionId}', ':sessionId').replace('{operationId}', ':operationId'),
    (c) => {
      const t = getTranslator(c);
      const sessionId = c.req.param('sessionId');
      const operationId = c.req.param('operationId');
      if (!sessionId || !operationId || !UUID_PATTERN.test(operationId)) {
        return c.json(buildErrorPayload(API_CODES.sftpValidationFailed, t('errors.validation.invalidPayload')), 400);
      }
      try {
        const operation = context.sftpSessionService.cancelArchiveOperation(sessionId, operationId);
        if (!operation) {
          return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
        }
        const payload: ApiSftpArchiveCancelResponse = createApiSuccess({
          code: API_CODES.sftpArchiveOperationStatusOk,
          message: t('success.sftp.archiveCancellationRequested'),
          data: localizeArchiveOperation(t, operation),
        });
        return c.json(payload, 202);
      } catch (error: unknown) {
        const failure = buildArchiveErrorResponse(t, error);
        return c.json(failure.payload, failure.status);
      }
    },
  );

  app.delete(API_PATHS.sftpCloseSession.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');

    if (!sessionId || !(await context.sftpSessionService.closeSession(sessionId))) {
      return c.json(buildErrorPayload(API_CODES.sftpSessionNotFound, t('errors.sftp.sessionNotFound')), 404);
    }

    return c.body(null, 204);
  });
};
