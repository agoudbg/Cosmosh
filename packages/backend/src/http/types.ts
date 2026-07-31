import type { PrismaClient } from '@prisma/client';

import type { AuditEventService } from '../audit/service.js';
import type { RuntimeMode } from '../db/prisma.js';
import type { LocalTerminalSessionService } from '../local-terminal/session-service.js';
import type { McpService } from '../mcp/service.js';
import type { PortForwardSessionService } from '../port-forward/session-service.js';
import type { SftpSessionService } from '../sftp/session-service.js';
import type { SshSessionService } from '../ssh/session-service.js';

/**
 * Shared runtime dependencies injected into HTTP route registration.
 */
export type BackendAppContext = {
  runtimeMode: RuntimeMode;
  isSecureLocalMode: boolean;
  internalToken: string | undefined;
  credentialEncryptionKey: Buffer;
  getDbClient: () => PrismaClient;
  auditEventService: AuditEventService;
  sshSessionService: SshSessionService;
  sftpSessionService: SftpSessionService;
  portForwardSessionService: PortForwardSessionService;
  localTerminalSessionService: LocalTerminalSessionService;
  mcpService: McpService;
};
