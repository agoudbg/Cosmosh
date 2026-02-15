import type { PrismaClient } from '@prisma/client';

import type { RuntimeMode } from '../db/prisma.js';

export type BackendAppContext = {
  runtimeMode: RuntimeMode;
  isSecureLocalMode: boolean;
  internalToken: string | undefined;
  credentialEncryptionKey: Buffer;
  getDbClient: () => PrismaClient;
};
