import type {
  ApiSshCreateFolderRequest,
  ApiSshCreateServerRequest,
  ApiSshCreateTagRequest,
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

  if ((authType === 'password' || authType === 'both') && !password) {
    return { error: 'Password is required for selected authentication type.' };
  }

  if ((authType === 'key' || authType === 'both') && !privateKey) {
    return { error: 'Private key is required for selected authentication type.' };
  }

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
