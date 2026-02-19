import type {
  ApiSshCreateFolderRequest,
  ApiSshCreateServerRequest,
  ApiSshCreateSessionRequest,
  ApiSshCreateTagRequest,
  ApiSshTrustFingerprintRequest,
  ApiSshUpdateServerRequest,
} from '@cosmosh/api-contract';
import type { SshAuthType } from '@prisma/client';

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

export const parseCreateFolderRequest = (payload: unknown): { value?: ApiSshCreateFolderRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const name = normalizeOptionalString(payload.name);
  if (!name || name.length > 120) {
    return { error: 'Folder name is required and must be 1-120 characters.' };
  }

  const note = normalizeOptionalString(payload.note);
  if (note && note.length > 1000) {
    return { error: 'Folder note must be 1000 characters or fewer.' };
  }

  return {
    value: {
      name,
      note,
    },
  };
};

export const parseCreateTagRequest = (payload: unknown): { value?: ApiSshCreateTagRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const name = normalizeOptionalString(payload.name);
  if (!name || name.length > 64) {
    return { error: 'Tag name is required and must be 1-64 characters.' };
  }

  return { value: { name } };
};

export const parseCreateServerRequest = (payload: unknown): { value?: ApiSshCreateServerRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const name = normalizeOptionalString(payload.name);
  const host = normalizeOptionalString(payload.host);
  const username = normalizeOptionalString(payload.username);
  const authType = payload.authType;
  const port = typeof payload.port === 'number' ? payload.port : Number(payload.port);

  if (!name || name.length > 120) {
    return { error: 'Server name is required and must be 1-120 characters.' };
  }

  if (!host || host.length > 255) {
    return { error: 'Host is required and must be 1-255 characters.' };
  }

  if (!username || username.length > 120) {
    return { error: 'Username is required and must be 1-120 characters.' };
  }

  if (!isValidPort(port)) {
    return { error: 'Port must be an integer in range 1-65535.' };
  }

  if (!isSshAuthType(authType)) {
    return { error: 'Auth type must be one of: password, key, both.' };
  }

  const password = normalizeOptionalString(payload.password);
  const privateKey = normalizeOptionalString(payload.privateKey);
  const privateKeyPassphrase = normalizeOptionalString(payload.privateKeyPassphrase);

  const folderId = normalizeOptionalString(payload.folderId);
  const note = normalizeOptionalString(payload.note);
  if (note && note.length > 3000) {
    return { error: 'Note must be 3000 characters or fewer.' };
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

export const parseUpdateServerRequest = (payload: unknown): { value?: ApiSshUpdateServerRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const name = normalizeOptionalString(payload.name);
  const host = normalizeOptionalString(payload.host);
  const username = normalizeOptionalString(payload.username);
  const authType = payload.authType;
  const port = typeof payload.port === 'number' ? payload.port : Number(payload.port);

  if (!name || name.length > 120) {
    return { error: 'Server name is required and must be 1-120 characters.' };
  }

  if (!host || host.length > 255) {
    return { error: 'Host is required and must be 1-255 characters.' };
  }

  if (!username || username.length > 120) {
    return { error: 'Username is required and must be 1-120 characters.' };
  }

  if (!isValidPort(port)) {
    return { error: 'Port must be an integer in range 1-65535.' };
  }

  if (!isSshAuthType(authType)) {
    return { error: 'Auth type must be one of: password, key, both.' };
  }

  const password = normalizeOptionalString(payload.password);
  const privateKey = normalizeOptionalString(payload.privateKey);
  const privateKeyPassphrase = normalizeOptionalString(payload.privateKeyPassphrase);
  const folderId = normalizeOptionalString(payload.folderId);
  const note = normalizeOptionalString(payload.note);

  if (note && note.length > 3000) {
    return { error: 'Note must be 3000 characters or fewer.' };
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

export const parseCreateSessionRequest = (payload: unknown): { value?: ApiSshCreateSessionRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const serverId = normalizeOptionalString(payload.serverId);
  if (!serverId) {
    return { error: 'serverId is required.' };
  }

  const cols = typeof payload.cols === 'number' ? payload.cols : Number(payload.cols ?? 120);
  const rows = typeof payload.rows === 'number' ? payload.rows : Number(payload.rows ?? 32);
  const term = normalizeOptionalString(payload.term) ?? 'xterm-256color';

  if (!Number.isInteger(cols) || cols < 20 || cols > 400) {
    return { error: 'cols must be an integer between 20 and 400.' };
  }

  if (!Number.isInteger(rows) || rows < 10 || rows > 200) {
    return { error: 'rows must be an integer between 10 and 200.' };
  }

  if (term.length < 2 || term.length > 64) {
    return { error: 'term must be a string between 2 and 64 characters.' };
  }

  return {
    value: {
      serverId,
      cols,
      rows,
      term,
    },
  };
};

export const parseTrustFingerprintRequest = (
  payload: unknown,
): { value?: ApiSshTrustFingerprintRequest; error?: string } => {
  if (!isRecord(payload)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const serverId = normalizeOptionalString(payload.serverId);
  const fingerprintSha256 = normalizeOptionalString(payload.fingerprintSha256);
  const algorithm = normalizeOptionalString(payload.algorithm) ?? 'sha256';

  if (!serverId) {
    return { error: 'serverId is required.' };
  }

  if (!fingerprintSha256 || fingerprintSha256.length > 255) {
    return { error: 'fingerprintSha256 is required and must be 1-255 characters.' };
  }

  if (algorithm.length < 1 || algorithm.length > 64) {
    return { error: 'algorithm must be 1-64 characters.' };
  }

  if (algorithm !== 'sha256') {
    return { error: 'Only sha256 host fingerprint algorithm is supported.' };
  }

  return {
    value: {
      serverId,
      fingerprintSha256,
      algorithm,
    },
  };
};
