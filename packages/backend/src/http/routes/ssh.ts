import {
  API_CODES,
  API_PATHS,
  type ApiSshCreateFolderResponse,
  type ApiSshCreateServerResponse,
  type ApiSshCreateTagResponse,
  type ApiSshListFoldersResponse,
  type ApiSshListServersResponse,
  type ApiSshListTagsResponse,
  createApiSuccess,
} from '@cosmosh/api-contract';
import { Prisma } from '@prisma/client';
import type { Hono } from 'hono';

import { encryptSensitiveValue } from '../../ssh/crypto.js';
import { mapServerToListItem, serverQueryInclude } from '../../ssh/mappers.js';
import { parseCreateFolderRequest, parseCreateServerRequest, parseCreateTagRequest } from '../../ssh/validation.js';
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
};
