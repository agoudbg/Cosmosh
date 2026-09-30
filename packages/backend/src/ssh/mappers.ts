import type { ApiSshListServersResponse } from '@cosmosh/api-contract';
import { DEFAULT_TERMINAL_CLIPBOARD_ACCESS, isTerminalClipboardAccess } from '@cosmosh/api-contract';
import type { Prisma } from '@prisma/client';

import { normalizeSshVisualColorKey } from './visuals.js';

/**
 * Normalizes persisted OSC 52 clipboard access values from SQLite text columns.
 *
 * @param value Raw database value.
 * @returns Supported clipboard access mode, defaulting to off for unknown legacy data.
 */
const normalizeTerminalClipboardAccess = (
  value: string,
): ApiSshListServersResponse['data']['items'][number]['terminalClipboardAccess'] => {
  return isTerminalClipboardAccess(value) ? value : DEFAULT_TERMINAL_CLIPBOARD_ACCESS;
};

/**
 * Shared Prisma include shape used by SSH server list/read queries.
 */
export const serverQueryInclude = {
  folder: true,
  keychain: {
    select: {
      id: true,
      authType: true,
      passwordEncrypted: true,
      privateKeyEncrypted: true,
    },
  },
  tags: {
    include: {
      tag: true,
    },
  },
  loginAudits: {
    where: {
      result: 'success',
    },
    orderBy: {
      attemptedAt: 'desc',
    },
    take: 1,
  },
} as const;

/**
 * Maps Prisma SSH server entity graph into API list item DTO.
 */
export const mapServerToListItem = (
  server: Prisma.SshServerGetPayload<{ include: typeof serverQueryInclude }>,
): ApiSshListServersResponse['data']['items'][number] => {
  return {
    id: server.id,
    name: server.name,
    iconKey: server.iconKey,
    colorKey: normalizeSshVisualColorKey(server.colorKey),
    host: server.host,
    port: server.port,
    username: server.username,
    strictHostKey: server.strictHostKey,
    enableSshCompression: server.enableSshCompression,
    disableCharacterWidthCompatibilityMode: server.disableCharacterWidthCompatibilityMode,
    terminalClipboardAccess: normalizeTerminalClipboardAccess(server.terminalClipboardAccess),
    proxyMode: server.proxyMode,
    proxyUrl: server.proxyUrl ?? undefined,
    keychainId: server.keychain.id,
    authType: server.keychain.authType,
    hasPassword: Boolean(server.keychain.passwordEncrypted),
    hasPrivateKey: Boolean(server.keychain.privateKeyEncrypted),
    note: server.note ?? undefined,
    folder: server.folder
      ? {
          id: server.folder.id,
          name: server.folder.name,
          iconKey: server.folder.iconKey,
          colorKey: normalizeSshVisualColorKey(server.folder.colorKey, 'slate'),
          note: server.folder.note ?? undefined,
          createdAt: server.folder.createdAt.toISOString(),
          updatedAt: server.folder.updatedAt.toISOString(),
        }
      : undefined,
    tags: server.tags.map((entry) => ({
      id: entry.tag.id,
      name: entry.tag.name,
      createdAt: entry.tag.createdAt.toISOString(),
      updatedAt: entry.tag.updatedAt.toISOString(),
    })),
    systemHostname: server.systemHostname ?? undefined,
    systemOs: server.systemOs ?? undefined,
    systemArch: server.systemArch ?? undefined,
    systemKernel: server.systemKernel ?? undefined,
    lastSystemSyncAt: server.lastSystemSyncAt?.toISOString(),
    lastLoginAudit: server.loginAudits[0]
      ? {
          id: server.loginAudits[0].id,
          attemptedAt: server.loginAudits[0].attemptedAt.toISOString(),
          result: server.loginAudits[0].result,
          failureReason: server.loginAudits[0].failureReason ?? undefined,
          clientIp: server.loginAudits[0].clientIp ?? undefined,
          sessionId: server.loginAudits[0].sessionId ?? undefined,
          sessionStartedAt: server.loginAudits[0].sessionStartedAt?.toISOString(),
          sessionEndedAt: server.loginAudits[0].sessionEndedAt?.toISOString(),
          commandCount: server.loginAudits[0].commandCount,
        }
      : undefined,
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
};
