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
  type ApiSshUpdateServerResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';
import prismaClientPackage from '@prisma/client';
import type { Hono } from 'hono';

const { Prisma } = prismaClientPackage;

import { decryptSensitiveValue, encryptSensitiveValue } from '../../ssh/crypto.js';
import { mapServerToListItem, serverQueryInclude } from '../../ssh/mappers.js';
import {
  parseCreateFolderRequest,
  parseCreateServerRequest,
  parseCreateSessionRequest,
  parseCreateTagRequest,
  parseTrustFingerprintRequest,
  parseUpdateServerRequest,
} from '../../ssh/validation.js';
import { buildErrorPayload } from '../errors.js';
import type { BackendAppContext } from '../types.js';

export const registerSshRoutes = (app: Hono, context: BackendAppContext): void => {
  app.get(API_PATHS.sshListFolders, async (c) => {
    const db = context.getDbClient();
    const folders = await db.sshFolder.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });

    const payload: ApiSshListFoldersResponse = createApiSuccess({
      code: API_CODES.sshFolderListOk,
      message: 'SSH folders fetched successfully.',
      data: {
        items: folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          note: folder.note ?? undefined,
          createdAt: folder.createdAt.toISOString(),
          updatedAt: folder.updatedAt.toISOString(),
        })),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sshCreateFolder, async (c) => {
    const parsed = parseCreateFolderRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, parsed.error ?? 'Invalid request payload.'), 400);
    }

    try {
      const db = context.getDbClient();
      const folder = await db.sshFolder.create({
        data: {
          name: parsed.value.name,
          note: parsed.value.note,
        },
      });

      const payload: ApiSshCreateFolderResponse = createApiSuccess({
        code: API_CODES.sshFolderCreateOk,
        message: 'SSH folder created successfully.',
        data: {
          item: {
            id: folder.id,
            name: folder.name,
            note: folder.note ?? undefined,
            createdAt: folder.createdAt.toISOString(),
            updatedAt: folder.updatedAt.toISOString(),
          },
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(buildErrorPayload(API_CODES.sshFolderConflict, 'A folder with this name already exists.'), 409);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshListTags, async (c) => {
    const db = context.getDbClient();
    const tags = await db.sshTag.findMany({
      orderBy: {
        updatedAt: 'desc',
      },
    });

    const payload: ApiSshListTagsResponse = createApiSuccess({
      code: API_CODES.sshTagListOk,
      message: 'SSH tags fetched successfully.',
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
    const parsed = parseCreateTagRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, parsed.error ?? 'Invalid request payload.'), 400);
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
        message: 'SSH tag created successfully.',
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
        return c.json(buildErrorPayload(API_CODES.sshTagConflict, 'A tag with this name already exists.'), 409);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshListServers, async (c) => {
    const db = context.getDbClient();
    const servers = await db.sshServer.findMany({
      include: serverQueryInclude,
      orderBy: {
        updatedAt: 'desc',
      },
    });

    const payload: ApiSshListServersResponse = createApiSuccess({
      code: API_CODES.sshServerListOk,
      message: 'SSH servers fetched successfully.',
      data: {
        items: servers.map(mapServerToListItem),
      },
    });

    return c.json(payload);
  });

  app.post(API_PATHS.sshCreateServer, async (c) => {
    const parsed = parseCreateServerRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, parsed.error ?? 'Invalid request payload.'), 400);
    }

    const db = context.getDbClient();
    const tagIds = parsed.value.tagIds ?? [];

    if (parsed.value.folderId) {
      const folder = await db.sshFolder.findUnique({
        where: { id: parsed.value.folderId },
        select: { id: true },
      });

      if (!folder) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, 'Folder was not found.'), 400);
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
        return c.json(buildErrorPayload(API_CODES.sshNotFound, 'One or more tags were not found.'), 400);
      }
    }

    try {
      const server = await db.sshServer.create({
        data: {
          name: parsed.value.name,
          host: parsed.value.host,
          port: parsed.value.port,
          username: parsed.value.username,
          authType: parsed.value.authType,
          passwordEncrypted: parsed.value.password
            ? encryptSensitiveValue(parsed.value.password, context.credentialEncryptionKey)
            : null,
          privateKeyEncrypted: parsed.value.privateKey
            ? encryptSensitiveValue(parsed.value.privateKey, context.credentialEncryptionKey)
            : null,
          privateKeyPassphraseEncrypted: parsed.value.privateKeyPassphrase
            ? encryptSensitiveValue(parsed.value.privateKeyPassphrase, context.credentialEncryptionKey)
            : null,
          note: parsed.value.note,
          folderId: parsed.value.folderId,
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
        message: 'SSH server created successfully.',
        data: {
          item: mapServerToListItem(server),
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(
          buildErrorPayload(
            API_CODES.sshServerConflict,
            'A server with the same host, port, and username already exists.',
          ),
          409,
        );
      }

      throw error;
    }
  });

  app.put(API_PATHS.sshUpdateServer.replace('{serverId}', ':serverId'), async (c) => {
    const serverId = c.req.param('serverId');
    if (!serverId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, 'serverId is required.'), 400);
    }

    const parsed = parseUpdateServerRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, parsed.error ?? 'Invalid request payload.'), 400);
    }

    const db = context.getDbClient();
    const tagIds = parsed.value.tagIds;

    const existingServer = await db.sshServer.findUnique({
      where: {
        id: serverId,
      },
      select: {
        id: true,
        passwordEncrypted: true,
        privateKeyEncrypted: true,
        privateKeyPassphraseEncrypted: true,
      },
    });

    if (!existingServer) {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, 'SSH server was not found.'), 404);
    }

    if (parsed.value.folderId) {
      const folder = await db.sshFolder.findUnique({
        where: { id: parsed.value.folderId },
        select: { id: true },
      });

      if (!folder) {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, 'Folder was not found.'), 400);
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
        return c.json(buildErrorPayload(API_CODES.sshNotFound, 'One or more tags were not found.'), 400);
      }
    }

    const shouldUsePassword = parsed.value.authType === 'password' || parsed.value.authType === 'both';
    const shouldUsePrivateKey = parsed.value.authType === 'key' || parsed.value.authType === 'both';

    const passwordEncrypted = shouldUsePassword
      ? parsed.value.password
        ? encryptSensitiveValue(parsed.value.password, context.credentialEncryptionKey)
        : existingServer.passwordEncrypted
      : null;

    const privateKeyEncrypted = shouldUsePrivateKey
      ? parsed.value.privateKey
        ? encryptSensitiveValue(parsed.value.privateKey, context.credentialEncryptionKey)
        : existingServer.privateKeyEncrypted
      : null;

    const privateKeyPassphraseEncrypted = shouldUsePrivateKey
      ? parsed.value.privateKeyPassphrase
        ? encryptSensitiveValue(parsed.value.privateKeyPassphrase, context.credentialEncryptionKey)
        : existingServer.privateKeyPassphraseEncrypted
      : null;

    if (shouldUsePassword && !passwordEncrypted) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, 'Password is required for selected authentication type.'),
        400,
      );
    }

    if (shouldUsePrivateKey && !privateKeyEncrypted) {
      return c.json(
        buildErrorPayload(API_CODES.sshValidationFailed, 'Private key is required for selected authentication type.'),
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
          authType: parsed.value.authType,
          passwordEncrypted,
          privateKeyEncrypted,
          privateKeyPassphraseEncrypted,
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
        message: 'SSH server updated successfully.',
        data: {
          item: mapServerToListItem(server),
        },
      });

      return c.json(payload);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return c.json(
          buildErrorPayload(
            API_CODES.sshServerConflict,
            'A server with the same host, port, and username already exists.',
          ),
          409,
        );
      }

      throw error;
    }
  });

  app.delete(API_PATHS.sshDeleteServer.replace('{serverId}', ':serverId'), async (c) => {
    const serverId = c.req.param('serverId');

    if (!serverId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, 'serverId is required.'), 400);
    }

    const db = context.getDbClient();

    try {
      await db.sshServer.delete({
        where: {
          id: serverId,
        },
      });

      return c.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return c.json(buildErrorPayload(API_CODES.sshNotFound, 'SSH server was not found.'), 404);
      }

      throw error;
    }
  });

  app.get(API_PATHS.sshGetServerCredentials.replace('{serverId}', ':serverId'), async (c) => {
    const serverId = c.req.param('serverId');

    if (!serverId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, 'serverId is required.'), 400);
    }

    const db = context.getDbClient();
    const server = await db.sshServer.findUnique({
      where: {
        id: serverId,
      },
      select: {
        id: true,
        authType: true,
        passwordEncrypted: true,
        privateKeyEncrypted: true,
        privateKeyPassphraseEncrypted: true,
      },
    });

    if (!server) {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, 'SSH server was not found.'), 404);
    }

    const payload: ApiSshGetServerCredentialsResponse = createApiSuccess({
      code: API_CODES.sshServerCredentialsOk,
      message: 'SSH server credentials fetched successfully.',
      data: {
        authType: server.authType,
        password: server.passwordEncrypted
          ? decryptSensitiveValue(server.passwordEncrypted, context.credentialEncryptionKey)
          : undefined,
        privateKey: server.privateKeyEncrypted
          ? decryptSensitiveValue(server.privateKeyEncrypted, context.credentialEncryptionKey)
          : undefined,
        privateKeyPassphrase: server.privateKeyPassphraseEncrypted
          ? decryptSensitiveValue(server.privateKeyPassphraseEncrypted, context.credentialEncryptionKey)
          : undefined,
      },
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.sshDeleteFolder.replace('{folderId}', ':folderId'), async (c) => {
    const folderId = c.req.param('folderId');

    if (!folderId) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, 'folderId is required.'), 400);
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
        return c.json(buildErrorPayload(API_CODES.sshNotFound, 'Folder was not found.'), 404);
      }

      throw error;
    }
  });

  app.post(API_PATHS.sshCreateSession, async (c) => {
    const parsed = parseCreateSessionRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, parsed.error ?? 'Invalid request payload.'), 400);
    }

    const result = await context.sshSessionService.createSession(parsed.value);

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, 'SSH server was not found.'), 404);
    }

    if (result.type === 'host-untrusted') {
      const payload: ApiSshCreateSessionHostVerificationRequiredResponse = {
        success: false,
        code: API_CODES.sshHostUntrusted,
        message: 'Host fingerprint is not trusted yet.',
        requestId: crypto.randomUUID(),
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
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, result.message), 400);
    }

    const payload: ApiSshCreateSessionResponse = createApiSuccess({
      code: API_CODES.sshSessionCreateOk,
      message: 'SSH session created successfully.',
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
    const parsed = parseTrustFingerprintRequest(await c.req.json().catch(() => undefined));
    if (!parsed.value) {
      return c.json(buildErrorPayload(API_CODES.sshValidationFailed, parsed.error ?? 'Invalid request payload.'), 400);
    }

    const result = await context.sshSessionService.trustFingerprint(parsed.value);

    if (result.type === 'not-found') {
      return c.json(buildErrorPayload(API_CODES.sshNotFound, 'SSH server was not found.'), 404);
    }

    const payload: ApiSshTrustFingerprintResponse = createApiSuccess({
      code: API_CODES.sshTrustFingerprintOk,
      message: 'Host fingerprint trusted successfully.',
      data: {
        trusted: true,
      },
    });

    return c.json(payload);
  });

  app.delete(API_PATHS.sshCloseSession.replace('{sessionId}', ':sessionId'), async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!sessionId || !context.sshSessionService.closeSession(sessionId)) {
      return c.json(buildErrorPayload(API_CODES.sshSessionNotFound, 'SSH session was not found.'), 404);
    }

    return c.body(null, 204);
  });
};
