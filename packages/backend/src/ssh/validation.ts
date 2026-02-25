import type {
  ApiSshCreateFolderRequest,
  ApiSshCreateServerRequest,
  ApiSshCreateSessionRequest,
  ApiSshCreateTagRequest,
  ApiSshTrustFingerprintRequest,
  ApiSshUpdateFolderRequest,
  ApiSshUpdateServerRequest,
} from '@cosmosh/api-contract';
import type { SshAuthType } from '@prisma/client';

type ValidationError = {
  i18nKey: string;
  params?: Record<string, string | number | boolean>;
  fallbackMessage: string;
};

type ValidationResult<TValue> = {
  value?: TValue;
  error?: ValidationError;
};

const buildValidationError = (
  i18nKey: string,
  fallbackMessage: string,
  params?: Record<string, string | number | boolean>,
): ValidationError => {
  return {
    i18nKey,
    params,
    fallbackMessage,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isValidPort = (value: number): boolean => {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
};

const isSshAuthType = (value: unknown): value is SshAuthType => {
  return value === 'password' || value === 'key' || value === 'both';
};

const toUniqueIds = (ids: unknown): string[] => {
  if (!Array.isArray(ids)) {
    return [];
  }

  const values = ids.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return [...new Set(values)];
};

const toOptionalUniqueIds = (ids: unknown): string[] | undefined => {
  if (!Array.isArray(ids)) {
    return undefined;
  }

  const values = ids.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  return [...new Set(values)];
};

/**
 * Parses and validates SSH folder creation payload.
 */
export const parseCreateFolderRequest = (payload: unknown): ValidationResult<ApiSshCreateFolderRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const name = normalizeOptionalString(payload.name);
  if (!name || name.length > 120) {
    return {
      error: buildValidationError(
        'errors.validation.folderNameLength',
        'Folder name is required and must be 1-120 characters.',
      ),
    };
  }

  const note = normalizeOptionalString(payload.note);
  if (note && note.length > 1000) {
    return {
      error: buildValidationError(
        'errors.validation.folderNoteLength',
        'Folder note must be 1000 characters or fewer.',
      ),
    };
  }

  return {
    value: {
      name,
      note,
    },
  };
};

/**
 * Parses and validates SSH tag creation payload.
 */
export const parseCreateTagRequest = (payload: unknown): ValidationResult<ApiSshCreateTagRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const name = normalizeOptionalString(payload.name);
  if (!name || name.length > 64) {
    return {
      error: buildValidationError(
        'errors.validation.tagNameLength',
        'Tag name is required and must be 1-64 characters.',
      ),
    };
  }

  return { value: { name } };
};

/**
 * Parses and validates SSH folder update payload.
 */
export const parseUpdateFolderRequest = (payload: unknown): ValidationResult<ApiSshUpdateFolderRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const name = normalizeOptionalString(payload.name);
  if (!name || name.length > 120) {
    return {
      error: buildValidationError(
        'errors.validation.folderNameLength',
        'Folder name is required and must be 1-120 characters.',
      ),
    };
  }

  const note = normalizeOptionalString(payload.note);
  if (note && note.length > 1000) {
    return {
      error: buildValidationError(
        'errors.validation.folderNoteLength',
        'Folder note must be 1000 characters or fewer.',
      ),
    };
  }

  return {
    value: {
      name,
      note,
    },
  };
};

/**
 * Parses and validates SSH server creation payload.
 */
export const parseCreateServerRequest = (payload: unknown): ValidationResult<ApiSshCreateServerRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const name = normalizeOptionalString(payload.name);
  const host = normalizeOptionalString(payload.host);
  const username = normalizeOptionalString(payload.username);
  const authType = payload.authType;
  const port = typeof payload.port === 'number' ? payload.port : Number(payload.port);

  if (!name || name.length > 120) {
    return {
      error: buildValidationError(
        'errors.validation.serverNameLength',
        'Server name is required and must be 1-120 characters.',
      ),
    };
  }

  if (!host || host.length > 255) {
    return {
      error: buildValidationError('errors.validation.hostLength', 'Host is required and must be 1-255 characters.'),
    };
  }

  if (!username || username.length > 120) {
    return {
      error: buildValidationError(
        'errors.validation.usernameLength',
        'Username is required and must be 1-120 characters.',
      ),
    };
  }

  if (!isValidPort(port)) {
    return {
      error: buildValidationError('errors.validation.portRange', 'Port must be an integer in range 1-65535.'),
    };
  }

  if (!isSshAuthType(authType)) {
    return {
      error: buildValidationError('errors.validation.authTypeEnum', 'Auth type must be one of: password, key, both.'),
    };
  }

  const password = normalizeOptionalString(payload.password);
  const privateKey = normalizeOptionalString(payload.privateKey);
  const privateKeyPassphrase = normalizeOptionalString(payload.privateKeyPassphrase);

  const shouldUsePassword = authType === 'password' || authType === 'both';
  const shouldUsePrivateKey = authType === 'key' || authType === 'both';

  if (shouldUsePassword && !password) {
    return {
      error: buildValidationError(
        'errors.validation.passwordRequiredForAuthType',
        'Password is required for selected authentication type.',
      ),
    };
  }

  if (shouldUsePrivateKey && !privateKey) {
    return {
      error: buildValidationError(
        'errors.validation.privateKeyRequiredForAuthType',
        'Private key is required for selected authentication type.',
      ),
    };
  }

  const folderId = normalizeOptionalString(payload.folderId);
  const note = normalizeOptionalString(payload.note);
  if (note && note.length > 3000) {
    return {
      error: buildValidationError('errors.validation.noteLength', 'Note must be 3000 characters or fewer.'),
    };
  }

  return {
    value: {
      name,
      host,
      port,
      username,
      authType,
      password,
      privateKey,
      privateKeyPassphrase,
      folderId,
      tagIds: toUniqueIds(payload.tagIds),
      note,
    },
  };
};

/**
 * Parses and validates SSH server update payload.
 */
export const parseUpdateServerRequest = (payload: unknown): ValidationResult<ApiSshUpdateServerRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const name = normalizeOptionalString(payload.name);
  const host = normalizeOptionalString(payload.host);
  const username = normalizeOptionalString(payload.username);
  const authType = payload.authType;
  const port = typeof payload.port === 'number' ? payload.port : Number(payload.port);

  if (!name || name.length > 120) {
    return {
      error: buildValidationError(
        'errors.validation.serverNameLength',
        'Server name is required and must be 1-120 characters.',
      ),
    };
  }

  if (!host || host.length > 255) {
    return {
      error: buildValidationError('errors.validation.hostLength', 'Host is required and must be 1-255 characters.'),
    };
  }

  if (!username || username.length > 120) {
    return {
      error: buildValidationError(
        'errors.validation.usernameLength',
        'Username is required and must be 1-120 characters.',
      ),
    };
  }

  if (!isValidPort(port)) {
    return {
      error: buildValidationError('errors.validation.portRange', 'Port must be an integer in range 1-65535.'),
    };
  }

  if (!isSshAuthType(authType)) {
    return {
      error: buildValidationError('errors.validation.authTypeEnum', 'Auth type must be one of: password, key, both.'),
    };
  }

  const password = normalizeOptionalString(payload.password);
  const privateKey = normalizeOptionalString(payload.privateKey);
  const privateKeyPassphrase = normalizeOptionalString(payload.privateKeyPassphrase);
  const folderId = normalizeOptionalString(payload.folderId);
  const note = normalizeOptionalString(payload.note);

  if (note && note.length > 3000) {
    return {
      error: buildValidationError('errors.validation.noteLength', 'Note must be 3000 characters or fewer.'),
    };
  }

  return {
    value: {
      name,
      host,
      port,
      username,
      authType,
      password,
      privateKey,
      privateKeyPassphrase,
      folderId,
      tagIds: toOptionalUniqueIds(payload.tagIds),
      note,
    },
  };
};

/**
 * Parses and validates SSH session creation payload.
 */
export const parseCreateSessionRequest = (payload: unknown): ValidationResult<ApiSshCreateSessionRequest> => {
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

  const cols = typeof payload.cols === 'number' ? payload.cols : Number(payload.cols ?? 120);
  const rows = typeof payload.rows === 'number' ? payload.rows : Number(payload.rows ?? 32);
  const term = normalizeOptionalString(payload.term) ?? 'xterm-256color';
  const connectTimeoutSec =
    typeof payload.connectTimeoutSec === 'number' ? payload.connectTimeoutSec : Number(payload.connectTimeoutSec ?? 45);

  if (!Number.isInteger(cols) || cols < 20 || cols > 400) {
    return {
      error: buildValidationError('errors.validation.colsRange', 'cols must be an integer between 20 and 400.'),
    };
  }

  if (!Number.isInteger(rows) || rows < 10 || rows > 200) {
    return {
      error: buildValidationError('errors.validation.rowsRange', 'rows must be an integer between 10 and 200.'),
    };
  }

  if (term.length < 2 || term.length > 64) {
    return {
      error: buildValidationError('errors.validation.termLength', 'term must be a string between 2 and 64 characters.'),
    };
  }

  if (!Number.isInteger(connectTimeoutSec) || connectTimeoutSec < 5 || connectTimeoutSec > 180) {
    return {
      error: buildValidationError(
        'errors.validation.connectTimeoutRange',
        'connectTimeoutSec must be an integer between 5 and 180.',
      ),
    };
  }

  return {
    value: {
      serverId,
      cols,
      rows,
      term,
      connectTimeoutSec,
    },
  };
};

/**
 * Parses and validates trusted host fingerprint request payload.
 */
export const parseTrustFingerprintRequest = (payload: unknown): ValidationResult<ApiSshTrustFingerprintRequest> => {
  if (!isRecord(payload)) {
    return {
      error: buildValidationError('errors.validation.requestBodyMustBeObject', 'Request body must be a JSON object.'),
    };
  }

  const serverId = normalizeOptionalString(payload.serverId);
  const fingerprintSha256 = normalizeOptionalString(payload.fingerprintSha256);
  const algorithm = normalizeOptionalString(payload.algorithm) ?? 'sha256';

  if (!serverId) {
    return {
      error: buildValidationError('errors.validation.serverIdRequired', 'serverId is required.'),
    };
  }

  if (!fingerprintSha256 || fingerprintSha256.length > 255) {
    return {
      error: buildValidationError(
        'errors.validation.fingerprintLength',
        'fingerprintSha256 is required and must be 1-255 characters.',
      ),
    };
  }

  if (algorithm.length < 1 || algorithm.length > 64) {
    return {
      error: buildValidationError('errors.validation.algorithmLength', 'algorithm must be 1-64 characters.'),
    };
  }

  if (algorithm !== 'sha256') {
    return {
      error: buildValidationError(
        'errors.validation.fingerprintAlgorithmUnsupported',
        'Only sha256 host fingerprint algorithm is supported.',
      ),
    };
  }

  return {
    value: {
      serverId,
      fingerprintSha256,
      algorithm,
    },
  };
};
