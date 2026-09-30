import crypto from 'node:crypto';

import {
  API_CODES,
  API_PATHS,
  type ApiSshCreateFolderResponse,
  type ApiSshCreateServerResponse,
  type ApiSshCreateSessionHostVerificationRequiredResponse,
  type ApiSshCreateSessionResponse,
  type ApiSshCreateTagResponse,
  type ApiSshGetServerCredentialsResponse,
  type ApiSshListFoldersResponse,
  type ApiSshListServersResponse,
  type ApiSshListTagsResponse,
  type ApiSshTrustFingerprintResponse,
  type ApiSshUpdateFolderResponse,
  type ApiSshUpdateServerResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';
import type { Prisma as PrismaTypes } from '@prisma/client';
import prismaClientPackage from '@prisma/client';

const { Prisma } = prismaClientPackage;

import type { AuditEventInput } from '../../audit/types.js';
import { decryptSensitiveValue, encryptSensitiveValue } from '../../ssh/crypto.js';
import { mapServerToListItem, serverQueryInclude } from '../../ssh/mappers.js';
import {
  parseCreateFolderRequest,
  parseCreateServerRequest,
  parseCreateSessionRequest,
  parseCreateTagRequest,
  parseTrustFingerprintRequest,
  parseUpdateFolderRequest,
  parseUpdateServerRequest,
} from '../../ssh/validation.js';
import { normalizeSshVisualColorKey } from '../../ssh/visuals.js';
import { buildErrorPayload } from '../errors.js';
import { type BackendHttpApp, getTranslator, translateValidationMessage } from '../i18n.js';
import type { BackendAppContext } from '../types.js';

const RESERVED_FAVORITE_TAG_NAME = 'favorite';

const isReservedSshTagName = (name: string): boolean => {
  return name.trim().toLowerCase() === RESERVED_FAVORITE_TAG_NAME;
};

const cleanupUnusedSshTags = async (db: ReturnType<BackendAppContext['getDbClient']>): Promise<void> => {
  const serverUnusedTags = await db.sshTag.findMany({
    where: {
      servers: {
        none: {},
      },
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (serverUnusedTags.length === 0) {
    return;
  }

  const serverUnusedTagIds = serverUnusedTags.map((tag) => tag.id);
  const keychainUsedTags = await db.sshKeychainTagLink.findMany({
    where: {
      tagId: {
        in: serverUnusedTagIds,
      },
    },
    select: {
      tagId: true,
    },
    distinct: ['tagId'],
  });

  const keychainUsedTagIdSet = new Set(keychainUsedTags.map((entry) => entry.tagId));
  const orphanTags = serverUnusedTags.filter((tag) => !keychainUsedTagIdSet.has(tag.id));

  const removableTagIds = orphanTags.filter((tag) => !isReservedSshTagName(tag.name)).map((tag) => tag.id);

  if (removableTagIds.length === 0) {
    return;
  }

  await db.sshTag.deleteMany({
    where: {
      id: {
        in: removableTagIds,
      },
    },
  });
};

const cleanupUnusedHiddenKeychains = async (db: ReturnType<BackendAppContext['getDbClient']>): Promise<void> => {
  await db.sshKeychain.deleteMany({
    where: {
      visibility: 'hidden',
      servers: {
        none: {},
      },
    },
  });
};

/**
 * Emits one SSH-domain audit event without blocking HTTP request flow.
 */
const logSshAuditEvent = (context: BackendAppContext, input: AuditEventInput): void => {
  void context.auditEventService.logEvent(input);
};

type KeychainWithRelations = PrismaTypes.SshKeychainGetPayload<{
  include: {
    folder: true;
    tags: {
      include: {
        tag: true;
      };
    };
  };
}>;

const mapKeychainToListItem = (keychain: KeychainWithRelations) => {
  return {
    id: keychain.id,
    name: keychain.name,
    iconKey: keychain.iconKey,
    colorKey: normalizeSshVisualColorKey(keychain.colorKey, 'emerald'),
    authType: keychain.authType,
    visibility: keychain.visibility,
    hasPassword: Boolean(keychain.passwordEncrypted),
    hasPrivateKey: Boolean(keychain.privateKeyEncrypted),
    note: keychain.note ?? undefined,
    folder: keychain.folder
      ? {
          id: keychain.folder.id,
          name: keychain.folder.name,
          iconKey: keychain.folder.iconKey,
          colorKey: normalizeSshVisualColorKey(keychain.folder.colorKey, 'slate'),
          note: keychain.folder.note ?? undefined,
          createdAt: keychain.folder.createdAt.toISOString(),
          updatedAt: keychain.folder.updatedAt.toISOString(),
        }
      : undefined,
    tags: keychain.tags.map((entry) => ({
      id: entry.tag.id,
      name: entry.tag.name,
      createdAt: entry.tag.createdAt.toISOString(),
      updatedAt: entry.tag.updatedAt.toISOString(),
    })),
    createdAt: keychain.createdAt.toISOString(),
    updatedAt: keychain.updatedAt.toISOString(),
  };
};

const ensureInlineCredentialKeychain = async (
  db: ReturnType<BackendAppContext['getDbClient']>,
  input: {
    serverName: string;
    authType?: 'password' | 'key' | 'both';
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
  },
  encryptionKey: Buffer,
  existing?: {
    keychainId: string;
    keychainVisibility: 'hidden' | 'shared';
    passwordEncrypted: string | null;
    privateKeyEncrypted: string | null;
    privateKeyPassphraseEncrypted: string | null;
  },
): Promise<string | null> => {
  if (!input.authType) {
    return null;
  }

  const shouldUsePassword = input.authType === 'password' || input.authType === 'both';
  const shouldUsePrivateKey = input.authType === 'key' || input.authType === 'both';

  const passwordEncrypted = shouldUsePassword
    ? input.password
      ? encryptSensitiveValue(input.password, encryptionKey)
      : (existing?.passwordEncrypted ?? null)
    : null;

  const privateKeyEncrypted = shouldUsePrivateKey
    ? input.privateKey
      ? encryptSensitiveValue(input.privateKey, encryptionKey)
      : (existing?.privateKeyEncrypted ?? null)
    : null;

  const privateKeyPassphraseEncrypted = shouldUsePrivateKey
    ? input.privateKeyPassphrase
      ? encryptSensitiveValue(input.privateKeyPassphrase, encryptionKey)
      : (existing?.privateKeyPassphraseEncrypted ?? null)
    : null;

  if (shouldUsePassword && !passwordEncrypted) {
    return null;
  }

  if (shouldUsePrivateKey && !privateKeyEncrypted) {
    return null;
  }

  const shouldUpdateExistingHidden = existing && existing.keychainVisibility === 'hidden';
  if (shouldUpdateExistingHidden) {
    await db.sshKeychain.update({
      where: {
        id: existing.keychainId,
      },
      data: {
        authType: input.authType,
        passwordEncrypted,
        privateKeyEncrypted,
        privateKeyPassphraseEncrypted,
      },
    });

    return existing.keychainId;
  }

  const keychain = await db.sshKeychain.create({
    data: {
      name: `${input.serverName} Keychain`,
      authType: input.authType,
      passwordEncrypted,
      privateKeyEncrypted,
      privateKeyPassphraseEncrypted,
      visibility: 'hidden',
    },
    select: {
      id: true,
    },
  });

  return keychain.id;
};

/**
 * Registers SSH domain routes for folders, tags, servers, credentials, and sessions.
 */
export const registerSshRoutes = (app: BackendHttpApp, context: BackendAppContext): void => {
  app.get(API_PATHS.sshListFolders, async (c) => {
    const t = getTranslator(c);
    const db = context.getDbClient();
    const folders = await db.sshFolder.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });

    const payload: ApiSshListFoldersResponse = createApiSuccess({
      code: API_CODES.sshFolderListOk,
      message: t('success.ssh.foldersFetched'),
      data: {
        items: folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          iconKey: folder.iconKey,
          colorKey: normalizeSshVisualColorKey(folder.colorKey, 'slate'),
          note: folder.note ?? undefined,
          createdAt: folder.createdAt.toISOString(),
          updatedAt: folder.updatedAt.toISOString(),
        })),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sshCreateFolder, async (c) => {
    const t = getTranslator(c);
    const parsed = parseCreateFolderRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    try {
      const db = context.getDbClient();
      const folder = await db.sshFolder.create({
        data: {
          name: parsed.value.name,
          note: parsed.value.note,
          iconKey: parsed.value.iconKey,
          colorKey: parsed.value.colorKey,
        },
      });

      const payload: ApiSshCreateFolderResponse = createApiSuccess({
        code: API_CODES.sshFolderCreateOk,
        message: t('success.ssh.folderCreated'),
        data: {
          item: {
            id: folder.id,
            name: folder.name,
            note: folder.note ?? undefined,
            iconKey: folder.iconKey,
            colorKey: normalizeSshVisualColorKey(folder.colorKey, 'slate'),
            createdAt: folder.createdAt.toISOString(),
            updatedAt: folder.updatedAt.toISOString(),
          },
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshFolderConflict, t('errors.ssh.folderConflict')), 409);
      }

      throw error;
    }
  });

  app.put(API_PATHS.sshUpdateFolder.replace('{folderId}', ':folderId'), async (c) => {
    const t = getTranslator(c);
    const folderId = c.req.param('folderId');

    if (!folderId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.folderIdRequired')), 400);
    }

    const parsed = parseUpdateFolderRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    try {
      const db = context.getDbClient();
      const folder = await db.sshFolder.update({
        where: {
          id: folderId,
        },
        data: {
          name: parsed.value.name,
          note: parsed.value.note,
          iconKey: parsed.value.iconKey,
          colorKey: parsed.value.colorKey,
        },
      });

      const payload: ApiSshUpdateFolderResponse = createApiSuccess({
        code: API_CODES.sshFolderUpdateOk,
        message: t('success.ssh.folderUpdated'),
        data: {
          item: {
            id: folder.id,
            name: folder.name,
            note: folder.note ?? undefined,
            iconKey: folder.iconKey,
            colorKey: normalizeSshVisualColorKey(folder.colorKey, 'slate'),
            createdAt: folder.createdAt.toISOString(),
            updatedAt: folder.updatedAt.toISOString(),
          },
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.folderNotFound')), 404);
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshFolderConflict, t('errors.ssh.folderConflict')), 409);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshListTags, async (c) => {
    const t = getTranslator(c);
    const db = context.getDbClient();
    await cleanupUnusedSshTags(db);
    const tags = await db.sshTag.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });

    const payload: ApiSshListTagsResponse = createApiSuccess({
      code: API_CODES.sshTagListOk,
      message: t('success.ssh.tagsFetched'),
      data: {
        items: tags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          createdAt: tag.createdAt.toISOString(),
          updatedAt: tag.updatedAt.toISOString(),
        })),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sshCreateTag, async (c) => {
    const t = getTranslator(c);
    const parsed = parseCreateTagRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    try {
      const db = context.getDbClient();
      const tag = await db.sshTag.create({
        data: {
          name: parsed.value.name,
        },
      });

      const payload: ApiSshCreateTagResponse = createApiSuccess({
        code: API_CODES.sshTagCreateOk,
        message: t('success.ssh.tagCreated'),
        data: {
          item: {
            id: tag.id,
            name: tag.name,
            createdAt: tag.createdAt.toISOString(),
            updatedAt: tag.updatedAt.toISOString(),
          },
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshTagConflict, t('errors.ssh.tagConflict')), 409);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshListKeychains, async (c) => {
    const t = getTranslator(c);
    const db = context.getDbClient();
    const keychains = await db.sshKeychain.findMany({
      include: {
        folder: true,
        tags: {
          include: {
            tag: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return c.json(
      createApiSuccess({
        code: API_CODES.sshKeychainListOk,
        message: t('success.ssh.keychainsFetched'),
        data: {
          items: keychains.map(mapKeychainToListItem),
        },
      }),
    );
  });

  app.post(API_PATHS.sshCreateKeychain, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const payload = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const authType = payload?.authType;
    const visibility = payload?.visibility;
    const password = typeof payload?.password === 'string' ? payload.password.trim() : undefined;
    const privateKey = typeof payload?.privateKey === 'string' ? payload.privateKey.trim() : undefined;
    const privateKeyPassphrase =
      typeof payload?.privateKeyPassphrase === 'string' ? payload.privateKeyPassphrase.trim() : undefined;
    const folderId = typeof payload?.folderId === 'string' ? payload.folderId.trim() : undefined;
    const tagIds = Array.isArray(payload?.tagIds)
      ? [...new Set(payload.tagIds.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))]
      : [];

    if (!name || name.length > 120) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverNameLength')), 400);
    }

    if (authType !== 'password' && authType !== 'key' && authType !== 'both') {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.authTypeEnum')), 400);
    }

    if (visibility !== undefined && visibility !== 'hidden' && visibility !== 'shared') {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const shouldUsePassword = authType === 'password' || authType === 'both';
    const shouldUsePrivateKey = authType === 'key' || authType === 'both';

    if (shouldUsePassword && !password) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.passwordRequiredForAuthType')),
        400,
      );
    }

    if (shouldUsePrivateKey && !privateKey) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.privateKeyRequiredForAuthType')),
        400,
      );
    }

    if (folderId) {
      const folder = await context.getDbClient().sshFolder.findUnique({
        where: { id: folderId },
        select: { id: true },
      });

      if (!folder) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.folderNotFound')), 400);
      }
    }

    if (tagIds.length > 0) {
      const existingTags = await context.getDbClient().sshTag.findMany({
        where: {
          id: {
            in: tagIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingTags.length !== tagIds.length) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.tagsNotFound')), 400);
      }
    }

    try {
      const db = context.getDbClient();
      const keychain = await db.sshKeychain.create({
        data: {
          name,
          authType,
          visibility: visibility === 'shared' ? 'shared' : 'hidden',
          iconKey: typeof payload?.iconKey === 'string' && payload.iconKey.trim() ? payload.iconKey.trim() : undefined,
          colorKey:
            typeof payload?.colorKey === 'string' && payload.colorKey.trim() ? payload.colorKey.trim() : undefined,
          note: typeof payload?.note === 'string' ? payload.note.trim() || undefined : undefined,
          folderId: folderId || undefined,
          tags: {
            create: tagIds.map((tagId) => ({
              tag: {
                connect: {
                  id: tagId,
                },
              },
            })),
          },
          passwordEncrypted: shouldUsePassword
            ? encryptSensitiveValue(password ?? '', context.credentialEncryptionKey)
            : null,
          privateKeyEncrypted: shouldUsePrivateKey
            ? encryptSensitiveValue(privateKey ?? '', context.credentialEncryptionKey)
            : null,
          privateKeyPassphraseEncrypted:
            shouldUsePrivateKey && privateKeyPassphrase
              ? encryptSensitiveValue(privateKeyPassphrase, context.credentialEncryptionKey)
              : null,
        },
        include: {
          folder: true,
          tags: {
            include: {
              tag: true,
            },
          },
        },
      });

      logSshAuditEvent(context, {
        category: 'ssh-keychain',
        action: 'create',
        outcome: 'success',
        severity: 'warning',
        entityType: 'ssh-keychain',
        entityId: keychain.id,
        requestId,
        metadata: {
          name: keychain.name,
          authType: keychain.authType,
          visibility: keychain.visibility,
          folderId: keychain.folder?.id,
          tagCount: keychain.tags.length,
        },
      });

      return c.json(
        createApiSuccess({
          code: API_CODES.sshKeychainCreateOk,
          message: t('success.ssh.keychainCreated'),
          data: {
            item: mapKeychainToListItem(keychain),
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshKeychainConflict, t('errors.ssh.serverConflict')), 409);
      }

      throw error;
    }
  });

  app.put(API_PATHS.sshUpdateKeychain.replace('{keychainId}', ':keychainId'), async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const keychainId = c.req.param('keychainId');
    const payload = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;

    if (!keychainId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverIdRequired')), 400);
    }

    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    const authType = payload?.authType;
    const visibility = payload?.visibility;
    const password = typeof payload?.password === 'string' ? payload.password.trim() : undefined;
    const privateKey = typeof payload?.privateKey === 'string' ? payload.privateKey.trim() : undefined;
    const privateKeyPassphrase =
      typeof payload?.privateKeyPassphrase === 'string' ? payload.privateKeyPassphrase.trim() : undefined;
    const folderId = typeof payload?.folderId === 'string' ? payload.folderId.trim() : undefined;
    const tagIds = Array.isArray(payload?.tagIds)
      ? [...new Set(payload.tagIds.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))]
      : [];

    if (!name || name.length > 120) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverNameLength')), 400);
    }

    if (authType !== 'password' && authType !== 'key' && authType !== 'both') {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.authTypeEnum')), 400);
    }

    if (visibility !== undefined && visibility !== 'hidden' && visibility !== 'shared') {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.invalidPayload')), 400);
    }

    const db = context.getDbClient();
    const existing = await db.sshKeychain.findUnique({
      where: { id: keychainId },
      select: {
        id: true,
        passwordEncrypted: true,
        privateKeyEncrypted: true,
        privateKeyPassphraseEncrypted: true,
      },
    });

    if (!existing) {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
    }

    const shouldUsePassword = authType === 'password' || authType === 'both';
    const shouldUsePrivateKey = authType === 'key' || authType === 'both';

    const passwordEncrypted = shouldUsePassword
      ? password
        ? encryptSensitiveValue(password, context.credentialEncryptionKey)
        : existing.passwordEncrypted
      : null;

    const privateKeyEncrypted = shouldUsePrivateKey
      ? privateKey
        ? encryptSensitiveValue(privateKey, context.credentialEncryptionKey)
        : existing.privateKeyEncrypted
      : null;

    const privateKeyPassphraseEncrypted = shouldUsePrivateKey
      ? privateKeyPassphrase
        ? encryptSensitiveValue(privateKeyPassphrase, context.credentialEncryptionKey)
        : existing.privateKeyPassphraseEncrypted
      : null;

    if (shouldUsePassword && !passwordEncrypted) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.passwordRequiredForAuthType')),
        400,
      );
    }

    if (shouldUsePrivateKey && !privateKeyEncrypted) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.privateKeyRequiredForAuthType')),
        400,
      );
    }

    if (folderId) {
      const folder = await db.sshFolder.findUnique({
        where: { id: folderId },
        select: { id: true },
      });

      if (!folder) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.folderNotFound')), 400);
      }
    }

    if (tagIds.length > 0) {
      const existingTags = await db.sshTag.findMany({
        where: {
          id: {
            in: tagIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingTags.length !== tagIds.length) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.tagsNotFound')), 400);
      }
    }

    const keychain = await db.sshKeychain.update({
      where: { id: keychainId },
      data: {
        name,
        authType,
        visibility: visibility === 'shared' ? 'shared' : 'hidden',
        iconKey: typeof payload?.iconKey === 'string' && payload.iconKey.trim() ? payload.iconKey.trim() : undefined,
        colorKey:
          typeof payload?.colorKey === 'string' && payload.colorKey.trim() ? payload.colorKey.trim() : undefined,
        note: typeof payload?.note === 'string' ? payload.note.trim() || undefined : undefined,
        folderId: folderId || undefined,
        passwordEncrypted,
        privateKeyEncrypted,
        privateKeyPassphraseEncrypted,
        tags: {
          deleteMany: {},
          create: tagIds.map((tagId) => ({
            tag: {
              connect: {
                id: tagId,
              },
            },
          })),
        },
      },
      include: {
        folder: true,
        tags: {
          include: {
            tag: true,
          },
        },
      },
    });

    logSshAuditEvent(context, {
      category: 'ssh-keychain',
      action: 'update',
      outcome: 'success',
      severity: 'warning',
      entityType: 'ssh-keychain',
      entityId: keychain.id,
      requestId,
      metadata: {
        name: keychain.name,
        authType: keychain.authType,
        visibility: keychain.visibility,
        folderId: keychain.folder?.id,
        tagCount: keychain.tags.length,
      },
    });

    return c.json(
      createApiSuccess({
        code: API_CODES.sshKeychainUpdateOk,
        message: t('success.ssh.keychainUpdated'),
        data: {
          item: mapKeychainToListItem(keychain),
        },
      }),
    );
  });

  app.delete(API_PATHS.sshDeleteKeychain.replace('{keychainId}', ':keychainId'), async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const keychainId = c.req.param('keychainId');
    if (!keychainId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverIdRequired')), 400);
    }

    const db = context.getDbClient();
    const inUse = await db.sshServer.count({
      where: {
        keychainId,
      },
    });

    if (inUse > 0) {
      return c.json(buildErrorPayload(API_CODES.sshKeychainInUse, t('errors.validation.invalidPayload')), 409);
    }

    try {
      await db.sshKeychain.delete({ where: { id: keychainId } });

      logSshAuditEvent(context, {
        category: 'ssh-keychain',
        action: 'delete',
        outcome: 'success',
        severity: 'warning',
        entityType: 'ssh-keychain',
        entityId: keychainId,
        requestId,
        metadata: {
          deleted: true,
        },
      });

      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshGetKeychainCredentials.replace('{keychainId}', ':keychainId'), async (c) => {
    const t = getTranslator(c);
    const keychainId = c.req.param('keychainId');
    if (!keychainId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverIdRequired')), 400);
    }

    const db = context.getDbClient();
    const keychain = await db.sshKeychain.findUnique({
      where: {
        id: keychainId,
      },
      select: {
        id: true,
        authType: true,
        passwordEncrypted: true,
        privateKeyEncrypted: true,
        privateKeyPassphraseEncrypted: true,
      },
    });

    if (!keychain) {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
    }

    return c.json(
      createApiSuccess({
        code: API_CODES.sshKeychainCredentialsOk,
        message: t('success.ssh.keychainCredentialsFetched'),
        data: {
          authType: keychain.authType,
          password: keychain.passwordEncrypted
            ? decryptSensitiveValue(keychain.passwordEncrypted, context.credentialEncryptionKey)
            : undefined,
          privateKey: keychain.privateKeyEncrypted
            ? decryptSensitiveValue(keychain.privateKeyEncrypted, context.credentialEncryptionKey)
            : undefined,
          privateKeyPassphrase: keychain.privateKeyPassphraseEncrypted
            ? decryptSensitiveValue(keychain.privateKeyPassphraseEncrypted, context.credentialEncryptionKey)
            : undefined,
        },
      }),
    );
  });

  app.get(API_PATHS.sshListServers, async (c) => {
    const t = getTranslator(c);
    const db = context.getDbClient();
    const servers = await db.sshServer.findMany({
      include: serverQueryInclude,
      orderBy: {
        updatedAt: 'desc',
      },
    });

    const payload: ApiSshListServersResponse = createApiSuccess({
      code: API_CODES.sshServerListOk,
      message: t('success.ssh.serversFetched'),
      data: {
        items: servers.map(mapServerToListItem),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sshCreateServer, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const parsed = parseCreateServerRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    const db = context.getDbClient();
    const tagIds = parsed.value.tagIds ?? [];

    if (parsed.value.folderId) {
      const folder = await db.sshFolder.findUnique({
        where: { id: parsed.value.folderId },
        select: { id: true },
      });

      if (!folder) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.folderNotFound')), 400);
      }
    }

    if (tagIds.length > 0) {
      const existingTags = await db.sshTag.findMany({
        where: {
          id: {
            in: tagIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingTags.length !== tagIds.length) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.tagsNotFound')), 400);
      }
    }

    try {
      if (parsed.value.keychainId) {
        const keychain = await db.sshKeychain.findUnique({
          where: { id: parsed.value.keychainId },
          select: { id: true },
        });

        if (!keychain) {
          return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 400);
        }
      }

      const keychainId =
        parsed.value.keychainId ??
        (await ensureInlineCredentialKeychain(
          db,
          {
            serverName: parsed.value.name,
            authType: parsed.value.authType,
            password: parsed.value.password,
            privateKey: parsed.value.privateKey,
            privateKeyPassphrase: parsed.value.privateKeyPassphrase,
          },
          context.credentialEncryptionKey,
        ));

      if (!keychainId) {
        return c.json(
          buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.passwordRequiredForAuthType')),
          400,
        );
      }

      const server = await db.sshServer.create({
        data: {
          name: parsed.value.name,
          host: parsed.value.host,
          port: parsed.value.port,
          username: parsed.value.username,
          strictHostKey: parsed.value.strictHostKey,
          enableSshCompression: parsed.value.enableSshCompression,
          disableCharacterWidthCompatibilityMode: parsed.value.disableCharacterWidthCompatibilityMode,
          terminalClipboardAccess: parsed.value.terminalClipboardAccess,
          proxyMode: parsed.value.proxyMode,
          proxyUrl: parsed.value.proxyUrl,
          keychainId,
          note: parsed.value.note,
          folderId: parsed.value.folderId,
          iconKey: parsed.value.iconKey,
          colorKey: parsed.value.colorKey,
          tags: {
            create: tagIds.map((tagId) => ({
              tag: {
                connect: {
                  id: tagId,
                },
              },
            })),
          },
        },
        include: serverQueryInclude,
      });

      const payload: ApiSshCreateServerResponse = createApiSuccess({
        code: API_CODES.sshServerCreateOk,
        message: t('success.ssh.serverCreated'),
        data: {
          item: mapServerToListItem(server),
        },
      });

      logSshAuditEvent(context, {
        category: 'ssh-server',
        action: 'create',
        outcome: 'success',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId,
        metadata: {
          name: server.name,
          host: server.host,
          port: server.port,
          username: server.username,
          keychainId: server.keychainId,
          strictHostKey: server.strictHostKey,
          enableSshCompression: server.enableSshCompression,
          disableCharacterWidthCompatibilityMode: server.disableCharacterWidthCompatibilityMode,
          terminalClipboardAccess: server.terminalClipboardAccess,
          proxyMode: server.proxyMode,
          folderId: server.folder?.id,
          tagCount: server.tags.length,
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshServerConflict, t('errors.ssh.serverConflict')), 409);
      }

      throw error;
    }
  });

  app.put(API_PATHS.sshUpdateServer.replace('{serverId}', ':serverId'), async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const serverId = c.req.param('serverId');
    if (!serverId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverIdRequired')), 400);
    }

    const parsed = parseUpdateServerRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    const db = context.getDbClient();
    const tagIds = parsed.value.tagIds;

    const existingServer = await db.sshServer.findUnique({
      where: {
        id: serverId,
      },
      select: {
        id: true,
        strictHostKey: true,
        enableSshCompression: true,
        disableCharacterWidthCompatibilityMode: true,
        terminalClipboardAccess: true,
        proxyMode: true,
        proxyUrl: true,
        keychainId: true,
        keychain: {
          select: {
            id: true,
            visibility: true,
            passwordEncrypted: true,
            privateKeyEncrypted: true,
            privateKeyPassphraseEncrypted: true,
          },
        },
      },
    });

    if (!existingServer) {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
    }

    if (parsed.value.folderId) {
      const folder = await db.sshFolder.findUnique({
        where: { id: parsed.value.folderId },
        select: { id: true },
      });

      if (!folder) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.folderNotFound')), 400);
      }
    }

    if (tagIds && tagIds.length > 0) {
      const existingTags = await db.sshTag.findMany({
        where: {
          id: {
            in: tagIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingTags.length !== tagIds.length) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.tagsNotFound')), 400);
      }
    }

    if (parsed.value.keychainId) {
      const targetKeychain = await db.sshKeychain.findUnique({
        where: { id: parsed.value.keychainId },
        select: { id: true },
      });

      if (!targetKeychain) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 400);
      }
    }

    const keychainId =
      parsed.value.keychainId ??
      (await ensureInlineCredentialKeychain(
        db,
        {
          serverName: parsed.value.name,
          authType: parsed.value.authType,
          password: parsed.value.password,
          privateKey: parsed.value.privateKey,
          privateKeyPassphrase: parsed.value.privateKeyPassphrase,
        },
        context.credentialEncryptionKey,
        {
          keychainId: existingServer.keychain.id,
          keychainVisibility: existingServer.keychain.visibility,
          passwordEncrypted: existingServer.keychain.passwordEncrypted,
          privateKeyEncrypted: existingServer.keychain.privateKeyEncrypted,
          privateKeyPassphraseEncrypted: existingServer.keychain.privateKeyPassphraseEncrypted,
        },
      ));

    if (!keychainId) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.privateKeyRequiredForAuthType')),
        400,
      );
    }

    try {
      const server = await db.sshServer.update({
        where: {
          id: serverId,
        },
        data: {
          name: parsed.value.name,
          host: parsed.value.host,
          port: parsed.value.port,
          username: parsed.value.username,
          keychainId,
          iconKey: parsed.value.iconKey,
          colorKey: parsed.value.colorKey,
          strictHostKey: parsed.value.strictHostKey ?? existingServer.strictHostKey,
          enableSshCompression: parsed.value.enableSshCompression ?? existingServer.enableSshCompression,
          disableCharacterWidthCompatibilityMode:
            parsed.value.disableCharacterWidthCompatibilityMode ??
            existingServer.disableCharacterWidthCompatibilityMode,
          terminalClipboardAccess: parsed.value.terminalClipboardAccess ?? existingServer.terminalClipboardAccess,
          proxyMode: parsed.value.proxyMode ?? existingServer.proxyMode,
          proxyUrl: parsed.value.proxyUrl !== undefined ? parsed.value.proxyUrl : existingServer.proxyUrl,
          note: parsed.value.note,
          folderId: parsed.value.folderId,
          ...(tagIds
            ? {
                tags: {
                  deleteMany: {},
                  create: tagIds.map((tagId) => ({
                    tag: {
                      connect: {
                        id: tagId,
                      },
                    },
                  })),
                },
              }
            : {}),
        },
        include: serverQueryInclude,
      });

      const payload: ApiSshUpdateServerResponse = createApiSuccess({
        code: API_CODES.sshServerUpdateOk,
        message: t('success.ssh.serverUpdated'),
        data: {
          item: mapServerToListItem(server),
        },
      });

      logSshAuditEvent(context, {
        category: 'ssh-server',
        action: 'update',
        outcome: 'success',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: server.id,
        requestId,
        metadata: {
          name: server.name,
          host: server.host,
          port: server.port,
          username: server.username,
          keychainId: server.keychainId,
          strictHostKey: server.strictHostKey,
          enableSshCompression: server.enableSshCompression,
          disableCharacterWidthCompatibilityMode: server.disableCharacterWidthCompatibilityMode,
          terminalClipboardAccess: server.terminalClipboardAccess,
          proxyMode: server.proxyMode,
          folderId: server.folder?.id,
          tagCount: server.tags.length,
          keychainReplaced: existingServer.keychainId !== keychainId,
        },
      });

      if (tagIds) {
        await cleanupUnusedSshTags(db);
      }

      if (existingServer.keychainId !== keychainId) {
        await cleanupUnusedHiddenKeychains(db);
      }

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshServerConflict, t('errors.ssh.serverConflict')), 409);
      }

      throw error;
    }
  });

  app.delete(API_PATHS.sshDeleteServer.replace('{serverId}', ':serverId'), async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const serverId = c.req.param('serverId');

    if (!serverId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverIdRequired')), 400);
    }

    const db = context.getDbClient();

    try {
      await db.sshServer.delete({
        where: {
          id: serverId,
        },
      });

      await cleanupUnusedSshTags(db);
      await cleanupUnusedHiddenKeychains(db);

      logSshAuditEvent(context, {
        category: 'ssh-server',
        action: 'delete',
        outcome: 'success',
        severity: 'warning',
        entityType: 'ssh-server',
        entityId: serverId,
        requestId,
        metadata: {
          deleted: true,
        },
      });

      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshGetServerCredentials.replace('{serverId}', ':serverId'), async (c) => {
    const t = getTranslator(c);
    const serverId = c.req.param('serverId');

    if (!serverId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.serverIdRequired')), 400);
    }

    const db = context.getDbClient();
    const server = await db.sshServer.findUnique({
      where: {
        id: serverId,
      },
      select: {
        id: true,
        keychain: {
          select: {
            authType: true,
            passwordEncrypted: true,
            privateKeyEncrypted: true,
            privateKeyPassphraseEncrypted: true,
          },
        },
      },
    });

    if (!server) {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
    }

    const payload: ApiSshGetServerCredentialsResponse = createApiSuccess({
      code: API_CODES.sshServerCredentialsOk,
      message: t('success.ssh.serverCredentialsFetched'),
      data: {
        authType: server.keychain.authType,
        password: server.keychain.passwordEncrypted
          ? decryptSensitiveValue(server.keychain.passwordEncrypted, context.credentialEncryptionKey)
          : undefined,
        privateKey: server.keychain.privateKeyEncrypted
          ? decryptSensitiveValue(server.keychain.privateKeyEncrypted, context.credentialEncryptionKey)
          : undefined,
        privateKeyPassphrase: server.keychain.privateKeyPassphraseEncrypted
          ? decryptSensitiveValue(server.keychain.privateKeyPassphraseEncrypted, context.credentialEncryptionKey)
          : undefined,
      },
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.sshDeleteFolder.replace('{folderId}', ':folderId'), async (c) => {
    const t = getTranslator(c);
    const folderId = c.req.param('folderId');

    if (!folderId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, t('errors.validation.folderIdRequired')), 400);
    }

    const db = context.getDbClient();

    try {
      await db.sshFolder.delete({
        where: {
          id: folderId,
        },
      });

      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.folderNotFound')), 404);
      }

      throw error;
    }
  });

  app.post(API_PATHS.sshCreateSession, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const parsed = parseCreateSessionRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    const result = await context.sshSessionService.createSession({
      ...parsed.value,
      locale: c.get('locale'),
      requestId,
    });

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
    }

    if (result.type === 'host-untrusted') {
      const payload: ApiSshCreateSessionHostVerificationRequiredResponse = {
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
          API_CODES.sshValidationFailed,
          translateValidationMessage(
            result.message,
            t('errors.ssh.sessionCreateFailed', { reason: result.message }),
            t('errors.ssh.sessionCreateFailedNoReason'),
          ),
        ),
        400,
      );
    }

    const payload: ApiSshCreateSessionResponse = createApiSuccess({
      code: API_CODES.sshSessionCreateOk,
      message: t('success.ssh.sessionCreated'),
      requestId,
      data: {
        sessionId: result.sessionId,
        serverId: result.serverId,
        websocketUrl: result.websocketUrl,
        websocketToken: result.websocketToken,
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sshTrustFingerprint, async (c) => {
    const t = getTranslator(c);
    const requestId = crypto.randomUUID();
    const parsed = parseTrustFingerprintRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(
        buildErrorPayload(
          API_CODES.sshValidationFailed,
          parsed.error ? t(parsed.error.i18nKey, parsed.error.params) : t('errors.validation.invalidPayload'),
        ),
        400,
      );
    }

    const result = await context.sshSessionService.trustFingerprint({
      ...parsed.value,
      requestId,
    });

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, t('errors.ssh.serverNotFound')), 404);
    }

    const payload: ApiSshTrustFingerprintResponse = createApiSuccess({
      code: API_CODES.sshTrustFingerprintOk,
      message: t('success.ssh.hostFingerprintTrusted'),
      requestId,
      data: {
        trusted: true,
      },
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.sshCloseSession.replace('{sessionId}', ':sessionId'), async (c) => {
    const t = getTranslator(c);
    const sessionId = c.req.param('sessionId');
    if (!sessionId || !context.sshSessionService.closeSession(sessionId)) {
      return c.json(buildErrorPayload(API_CODES.sshSessionNotFound, t('errors.ssh.sessionNotFound')), 404);
    }

    return c.body(null, 204);
  });
};
