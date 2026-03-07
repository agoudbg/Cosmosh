-- CreateTable
CREATE TABLE "SshFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SshTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SshServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "passwordEncrypted" TEXT,
    "privateKeyEncrypted" TEXT,
    "privateKeyPassphraseEncrypted" TEXT,
    "note" TEXT,
    "folderId" TEXT,
    "systemHostname" TEXT,
    "systemOs" TEXT,
    "systemArch" TEXT,
    "systemKernel" TEXT,
    "lastSystemSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SshServer_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "SshFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SshKnownHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "keyType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "trusted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeAccountId" TEXT NOT NULL DEFAULT '',
    "scopeDeviceId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SshServerTag" (
    "serverId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("serverId", "tagId"),
    CONSTRAINT "SshServerTag_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "SshServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SshServerTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "SshTag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SshLoginAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "failureReason" TEXT,
    "clientIp" TEXT,
    "sessionId" TEXT,
    "sessionStartedAt" DATETIME,
    "sessionEndedAt" DATETIME,
    "commandCount" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SshLoginAudit_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "SshServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SshFolder_name_key" ON "SshFolder"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SshTag_name_key" ON "SshTag"("name");

-- CreateIndex
CREATE INDEX "SshServer_folderId_idx" ON "SshServer"("folderId");

-- CreateIndex
CREATE UNIQUE INDEX "SshServer_host_port_username_key" ON "SshServer"("host", "port", "username");

-- CreateIndex
CREATE INDEX "SshKnownHost_host_port_idx" ON "SshKnownHost"("host", "port");

-- CreateIndex
CREATE INDEX "AppSettings_scopeDeviceId_idx" ON "AppSettings"("scopeDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_scopeAccountId_scopeDeviceId_key" ON "AppSettings"("scopeAccountId", "scopeDeviceId");

-- CreateIndex
CREATE INDEX "SshServerTag_tagId_idx" ON "SshServerTag"("tagId");

-- CreateIndex
CREATE INDEX "SshLoginAudit_serverId_attemptedAt_idx" ON "SshLoginAudit"("serverId", "attemptedAt");

