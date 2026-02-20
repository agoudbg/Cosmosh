import type { PrismaClient } from '@prisma/client';

import type { RuntimeMode } from '../db/prisma.js';
import type { LocalTerminalSessionService } from '../local-terminal/session-service.js';
import type { SshSessionService } from '../ssh/session-service.js';

export type BackendAppContext = {
  runtimeMode: RuntimeMode;
  isSecureLocalMode: boolean;
  internalToken: string | undefined;
  credentialEncryptionKey: Buffer;
  getDbClient: () => PrismaClient;
  sshSessionService: SshSessionService;
  localTerminalSessionService: LocalTerminalSessionService;
};
