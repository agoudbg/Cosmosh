ALTER TABLE "SshServer"
ADD COLUMN "mcpCommandPolicy" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE "McpPairingToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenEncrypted" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);

CREATE INDEX "McpPairingToken_revokedAt_idx" ON "McpPairingToken"("revokedAt");
