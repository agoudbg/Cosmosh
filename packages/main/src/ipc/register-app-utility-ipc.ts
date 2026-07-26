import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type {
  AppCloseConfirmationResponse,
  SftpOpenWithApplication,
  SftpTemporaryFileWatchChange,
  SftpUploadFileSelection,
  SystemProxyResolveResult,
} from '@cosmosh/api-contract';
import type { TranslationParams } from '@cosmosh/i18n';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
  session,
  shell,
  type WebContents,
} from 'electron';

import type { DatabaseSecurityInfo } from '../security/database-encryption';
import type { SftpDownloadTargetAuthorizationRegistry } from './sftp-download-target-authorizations';
import { openWithDialogWindows, resolveMacOsOpenWithHelperInvocation } from './sftp-open-with-runtime';
import {
  createPrivateSftpTemporaryDirectory,
  isPathInsideDirectory,
  resolveExistingSftpTemporaryFilePath as resolveSecureExistingSftpTemporaryFilePath,
  resolveStagedSftpTemporaryFilePath,
} from './sftp-temporary-root';
import {
  cleanupStagedSftpUploadFiles,
  normalizeDroppedSftpUploadLocalEntries,
  stageDroppedSftpUploadLocalEntries,
  stageSftpUploadLocalFile,
} from './sftp-upload-staging';
import {
  collectProcessPerformanceStats,
  createMainCpuUsagePercentSampler,
  exportMainProcessHeapSnapshot,
  type ProcessPerformanceStatsPayload,
} from './utils/process-performance';

type MacOsOpenWithHelperApplication = {
  name: string;
  path: string;
  bundleIdentifier?: string;
};

type SftpTemporaryFileWatchRecord = {
  watchId: string;
  localPath: string;
  ownerWebContentsId: number;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
  lastSignature: string;
};

const stagedSftpUploadPaths = new Set<string>();
const MAX_MACOS_OPEN_WITH_HELPER_OUTPUT_BYTES = 1024 * 1024;
const MAX_CLOSE_CONFIRMATION_REQUEST_ID_LENGTH = 128;
const MAX_SFTP_TEMPORARY_IMAGE_PREVIEW_BYTES = 128 * 1024 * 1024;
const SFTP_TEMP_FILE_WATCH_DEBOUNCE_MS = 800;
const SFTP_TEMPORARY_IMAGE_PREVIEW_MIME_TYPES: Readonly<Record<string, string>> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/**
 * Builds the HTTPS target URL used by Chromium's system proxy resolver.
 *
 * @param request Untrusted renderer payload.
 * @returns Target URL.
 */
const buildSystemProxyTargetUrl = (request: unknown): string => {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('Invalid system proxy resolution target.');
  }

  const payload = request as Record<string, unknown>;
  const host = typeof payload.host === 'string' ? payload.host.trim() : '';
  const port = payload.port;
  if (!host || host.length > 255 || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid system proxy resolution target.');
  }

  const normalizedHost = net.isIP(host) === 6 ? `[${host}]` : host;
  try {
    const targetUrl = new URL(`https://${normalizedHost}:${String(port)}/`);
    if (
      targetUrl.port !== String(port) ||
      targetUrl.pathname !== '/' ||
      targetUrl.username ||
      targetUrl.password ||
      targetUrl.search ||
      targetUrl.hash
    ) {
      throw new Error('Invalid system proxy resolution target.');
    }

    return targetUrl.toString();
  } catch {
    throw new Error('Invalid system proxy resolution target.');
  }
};

/**
 * Dependency contract for registering app-level utility IPC handlers.
 */
export type RegisterAppUtilityIpcHandlersOptions = {
  /** Returns current main window reference (if any). */
  getMainWindow: () => BrowserWindow | null;
  /** Resolves a Main-owned close confirmation from its renderer owner. */
  resolveCloseConfirmation: (senderWebContentsId: number, response: AppCloseConfirmationResponse) => void;
  /** Returns active locale used by main process. */
  getLocale: () => string;
  /** Translates main-process UI text using the active locale. */
  translateMain: (key: string, params?: TranslationParams) => string;
  /**
   * Applies locale update and returns normalized locale.
   * Implementation is responsible for side effects such as updating window title.
   */
  setLocale: (nextLocale: string) => string;
  /** Returns pending launch working directory forwarded from startup/single-instance flow. */
  getPendingLaunchWorkingDirectory: () => string | null;
  /** Resolves build timestamp for version metadata. */
  resolveBuildTime: () => Promise<string>;
  /** Returns non-sensitive database encryption diagnostics. */
  getDatabaseSecurityInfo: () => Promise<DatabaseSecurityInfo>;
  /** Restarts backend runtime without restarting the full Electron app. */
  restartBackendRuntime: () => Promise<boolean>;
  /** Returns current backend process ID for diagnostics sampling. */
  getBackendProcessId: () => number | null;
  /** Applies runtime Windows title bar symbol color for system menu controls. */
  setWindowsSystemMenuSymbolColor: (symbolColor: string) => boolean;
  /** Tracks exact renderer-owned paths that the backend SFTP download proxy may write. */
  sftpDownloadTargetAuthorizations: SftpDownloadTargetAuthorizationRegistry;
  /** Returns the canonical Main-owned SFTP temp root shared with Backend. */
  getSftpTemporaryRootPath: () => string;
};

/**
 * Validates the renderer response before forwarding it to the Main close broker.
 *
 * @param value Untrusted renderer IPC payload.
 * @returns Validated close confirmation response, or `null` when malformed.
 */
const parseCloseConfirmationResponse = (value: unknown): AppCloseConfirmationResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requestId !== 'string' ||
    candidate.requestId.length === 0 ||
    candidate.requestId.length > MAX_CLOSE_CONFIRMATION_REQUEST_ID_LENGTH ||
    typeof candidate.confirmed !== 'boolean'
  ) {
    return null;
  }

  return {
    requestId: candidate.requestId,
    confirmed: candidate.confirmed,
  };
};

/**
 * Returns the best available app window for dialog and webContents operations.
 *
 * @param options Runtime dependencies for app utility handlers.
 * @returns Focused window first, otherwise current main window reference.
 */
const resolveTargetWindow = (options: RegisterAppUtilityIpcHandlersOptions): BrowserWindow | null => {
  return BrowserWindow.getFocusedWindow() ?? options.getMainWindow();
};

/**
 * Removes characters that are unsafe in local file names before creating SFTP temp paths.
 *
 * @param fileName Renderer-provided display file name.
 * @returns Safe local file name with a stable fallback.
 */
const sanitizeSftpTemporaryFileName = (fileName: string | undefined): string => {
  const rawName = typeof fileName === 'string' ? fileName : '';
  const sanitized = Array.from(rawName)
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint < 32 ? '_' : character.replace(/[<>:"/\\|?*]/g, '_');
    })
    .join('')
    .replace(/[. ]+$/g, '')
    .trim();

  return sanitized || 'download';
};

/**
 * Resolves a renderer-provided SFTP temp path and ensures it points to an existing file.
 *
 * @param options Runtime dependencies used to resolve the Main-owned temp root.
 * @param candidatePath Renderer-provided local path.
 * @returns Canonical existing local file path inside the Cosmosh SFTP temp root.
 */
const resolveExistingSftpTemporaryFilePath = async (
  options: RegisterAppUtilityIpcHandlersOptions,
  candidatePath: string | undefined,
): Promise<string> => {
  return resolveSecureExistingSftpTemporaryFilePath(options.getSftpTemporaryRootPath(), candidatePath);
};

/**
 * Creates a unique destination path under the Cosmosh SFTP temp root.
 *
 * @param options Runtime dependencies used to resolve the Main-owned temp root.
 * @param fileName Desired file name from the remote entry.
 * @returns Absolute local path that the backend download endpoint may write to.
 */
const createSftpTemporaryFilePath = async (
  options: RegisterAppUtilityIpcHandlersOptions,
  fileName: string | undefined,
): Promise<string> => {
  const temporaryDirectoryPath = await createPrivateSftpTemporaryDirectory(options.getSftpTemporaryRootPath());
  return path.join(temporaryDirectoryPath, sanitizeSftpTemporaryFileName(fileName));
};

/**
 * Removes staged SFTP upload files without allowing deletion outside the temp root.
 *
 * @param localPaths Renderer-provided staged paths.
 * @returns Promise resolved after best-effort cleanup.
 */
const cleanupSftpTemporaryFiles = async (
  options: RegisterAppUtilityIpcHandlersOptions,
  localPaths: readonly string[],
): Promise<void> => {
  await cleanupStagedSftpUploadFiles(localPaths, {
    resolveTemporaryCandidatePath: (candidatePath) =>
      resolveStagedSftpTemporaryFilePath(options.getSftpTemporaryRootPath(), candidatePath),
    stagedUploadPaths: stagedSftpUploadPaths,
    temporaryRootPath: options.getSftpTemporaryRootPath(),
    isPathInsideDirectory,
  });
};

/**
 * Opens the native multi-file picker and stages all accepted upload files.
 *
 * @param options Runtime dependencies used to resolve the owning window.
 * @returns Native picker result with controlled temp-file descriptors.
 */
const selectAndStageSftpUploadFiles = async (
  options: RegisterAppUtilityIpcHandlersOptions,
): Promise<SftpUploadFileSelection> => {
  const targetWindow = resolveTargetWindow(options);
  const dialogOptions: OpenDialogOptions = {
    title: 'Upload Files',
    buttonLabel: 'Upload',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'All Files',
        extensions: ['*'],
      },
    ],
  };
  const selection = targetWindow
    ? await dialog.showOpenDialog(targetWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (selection.canceled || selection.filePaths.length === 0) {
    return { canceled: true, files: [] };
  }

  const stagedResults = await Promise.allSettled(
    selection.filePaths.map((filePath) =>
      stageSftpUploadLocalFile(filePath, {
        createTemporaryFilePath: (fileName) => createSftpTemporaryFilePath(options, fileName),
        stagedUploadPaths: stagedSftpUploadPaths,
      }),
    ),
  );
  const stagedFiles = stagedResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failedResult = stagedResults.find((result) => result.status === 'rejected');
  if (failedResult?.status === 'rejected') {
    await cleanupSftpTemporaryFiles(
      options,
      stagedFiles.map((file) => file.localPath),
    );
    throw failedResult.reason;
  }

  return {
    canceled: false,
    files: stagedFiles,
  };
};

/**
 * Stages files dropped from the host OS after preload resolves File objects to paths.
 *
 * @param droppedEntries Unknown IPC payload from preload.
 * @returns Staged regular files plus rejected dropped entries.
 */
const stageRendererDroppedSftpUploadFiles = async (
  options: RegisterAppUtilityIpcHandlersOptions,
  droppedEntries: unknown,
): Promise<SftpUploadFileSelection> => {
  return stageDroppedSftpUploadLocalEntries(normalizeDroppedSftpUploadLocalEntries(droppedEntries), {
    createTemporaryFilePath: (fileName) => createSftpTemporaryFilePath(options, fileName),
    stagedUploadPaths: stagedSftpUploadPaths,
  });
};

/**
 * Validates renderer-provided staging paths before requesting cleanup.
 *
 * @param localPaths Unknown IPC payload.
 * @returns Whether the cleanup request was valid and processed.
 */
const cleanupRendererStagedSftpUploadFiles = async (
  options: RegisterAppUtilityIpcHandlersOptions,
  localPaths: unknown,
): Promise<boolean> => {
  if (!Array.isArray(localPaths) || !localPaths.every((localPath) => typeof localPath === 'string')) {
    return false;
  }

  await cleanupSftpTemporaryFiles(options, localPaths);
  return true;
};

/**
 * Builds the signature used to dedupe repeated file-system notifications.
 *
 * @param filePath Existing local temp file path.
 * @returns Stable signature and payload fields for the file state.
 */
const resolveSftpTemporaryFileSignature = async (
  filePath: string,
): Promise<{ signature: string; change: Omit<SftpTemporaryFileWatchChange, 'watchId' | 'localPath'> }> => {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error('Invalid file path.');
  }

  return {
    signature: `${stats.size}:${stats.mtimeMs}`,
    change: {
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    },
  };
};

/**
 * Reads a validated SFTP temp image as a data URL for renderer preview.
 *
 * @param candidatePath Renderer-provided local path.
 * @returns Data URL suitable for an image src attribute.
 */
const readSftpTemporaryImagePreviewDataUrl = async (
  options: RegisterAppUtilityIpcHandlersOptions,
  candidatePath: string | undefined,
): Promise<string> => {
  const normalizedPath = await resolveExistingSftpTemporaryFilePath(options, candidatePath);
  const stats = await fs.stat(normalizedPath);
  if (stats.size > MAX_SFTP_TEMPORARY_IMAGE_PREVIEW_BYTES) {
    throw new Error('SFTP image preview file is too large.');
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  const mimeType = SFTP_TEMPORARY_IMAGE_PREVIEW_MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error('Unsupported SFTP image preview type.');
  }

  const content = await fs.readFile(normalizedPath);
  return `data:${mimeType};base64,${content.toString('base64')}`;
};

/**
 * Stops one active SFTP temp-file watcher and clears its pending debounce work.
 *
 * @param watchers Active watcher registry.
 * @param watchId Watch id returned to the renderer.
 * @returns Whether a watcher was stopped.
 */
const stopSftpTemporaryFileWatcher = (
  watchers: Map<string, SftpTemporaryFileWatchRecord>,
  watchId: string | undefined,
): boolean => {
  if (!watchId) {
    return false;
  }

  const record = watchers.get(watchId);
  if (!record) {
    return false;
  }

  if (record.debounceTimer) {
    clearTimeout(record.debounceTimer);
  }
  record.watcher.close();
  watchers.delete(watchId);
  return true;
};

/**
 * Stops every watcher owned by one renderer webContents.
 *
 * @param watchers Active watcher registry.
 * @param ownerWebContentsId Renderer webContents id.
 * @returns void.
 */
const stopSftpTemporaryFileWatchersForOwner = (
  watchers: Map<string, SftpTemporaryFileWatchRecord>,
  ownerWebContentsId: number,
): void => {
  Array.from(watchers.values())
    .filter((record) => record.ownerWebContentsId === ownerWebContentsId)
    .forEach((record) => {
      stopSftpTemporaryFileWatcher(watchers, record.watchId);
    });
};

/**
 * Runs the macOS NSWorkspace helper and captures bounded stdout.
 *
 * @param args Helper command arguments.
 * @returns Helper stdout.
 */
const runMacOsOpenWithHelper = async (args: string[]): Promise<string> => {
  const invocation = await resolveMacOsOpenWithHelperInvocation({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDirectoryPath: __dirname,
    workingDirectoryPath: process.cwd(),
  });
  if (!invocation) {
    throw new Error('macOS Open With helper is unavailable.');
  }

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
      cwd: invocation.workingDirectoryPath,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, 'utf8') > MAX_MACOS_OPEN_WITH_HELPER_OUTPUT_BYTES) {
        child.kill();
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `Open With helper failed, exit code: ${code ?? 'unknown'}`));
    });
  });
};

/**
 * Checks whether a value is a plain object record.
 *
 * @param value Unknown value.
 * @returns True when the value can be accessed as a record.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Parses one macOS helper application row.
 *
 * @param value Unknown helper row.
 * @returns Normalized app descriptor, or null for invalid rows.
 */
const parseMacOsOpenWithHelperApplication = (value: unknown): MacOsOpenWithHelperApplication | null => {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.name !== 'string') {
    return null;
  }

  const appPath = value.path.trim();
  const appName = value.name.trim();
  if (!appPath || !appName || !path.isAbsolute(appPath)) {
    return null;
  }

  return {
    name: appName,
    path: appPath,
    ...(typeof value.bundleIdentifier === 'string' && value.bundleIdentifier.trim()
      ? { bundleIdentifier: value.bundleIdentifier.trim() }
      : {}),
  };
};

/**
 * Lists macOS applications that Launch Services says can open a file URL.
 *
 * @param filePath Existing or candidate local file path inside the SFTP temp root.
 * @returns Applications available for the file type.
 */
const listMacOsOpenWithApplications = async (filePath: string): Promise<SftpOpenWithApplication[]> => {
  if (process.platform !== 'darwin') {
    return [];
  }

  const output = await runMacOsOpenWithHelper(['list', filePath]);
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    return [];
  }

  const helperApplications = parsed
    .map(parseMacOsOpenWithHelperApplication)
    .filter((application): application is MacOsOpenWithHelperApplication => application !== null);

  const applications = await Promise.all(
    helperApplications.map(async (application): Promise<SftpOpenWithApplication> => {
      const icon = await app.getFileIcon(application.path, { size: 'small' }).catch(() => null);
      return {
        id: application.bundleIdentifier ?? application.path,
        name: application.name,
        path: application.path,
        ...(application.bundleIdentifier ? { bundleIdentifier: application.bundleIdentifier } : {}),
        ...(icon ? { iconDataUrl: icon.toDataURL() } : {}),
      };
    }),
  );

  return applications;
};

/**
 * Opens a temp file with a specific macOS application after validating the app is eligible.
 *
 * @param filePath Existing local file path inside the SFTP temp root.
 * @param applicationPath Application bundle path selected by the renderer.
 * @returns Nothing.
 */
const openWithApplicationMacOs = async (filePath: string, applicationPath: string | undefined): Promise<void> => {
  if (typeof applicationPath !== 'string' || applicationPath.trim().length === 0) {
    throw new Error('Invalid application path.');
  }

  const normalizedApplicationPath = path.resolve(applicationPath.trim());
  const availableApplications = await listMacOsOpenWithApplications(filePath);
  const isApplicationAllowed = availableApplications.some(
    (application) => path.resolve(application.path) === normalizedApplicationPath,
  );

  if (!isApplicationAllowed) {
    throw new Error('Application is not available for this file.');
  }

  await runMacOsOpenWithHelper(['open', filePath, normalizedApplicationPath]);
};

/**
 * Registers shell/window/i18n utility channels exposed to renderer.
 */
export const registerAppUtilityIpcHandlers = (options: RegisterAppUtilityIpcHandlersOptions): void => {
  const sampleMainCpuUsagePercent = createMainCpuUsagePercentSampler();
  const sftpTemporaryFileWatchers = new Map<string, SftpTemporaryFileWatchRecord>();
  const sftpAuthorizationCleanupOwnerIds = new Set<number>();

  /**
   * Authorizes a Main-selected SFTP download target and revokes it with its renderer owner.
   *
   * @param ownerWebContents Renderer that requested the local target.
   * @param localPath Main-selected local path.
   * @param reusable Whether repeated backend downloads may reuse the same target.
   * @returns Normalized authorized path.
   */
  const authorizeSftpDownloadTarget = (ownerWebContents: WebContents, localPath: string, reusable: boolean): string => {
    const authorizedPath = options.sftpDownloadTargetAuthorizations.authorize(ownerWebContents.id, localPath, {
      reusable,
    });

    if (!sftpAuthorizationCleanupOwnerIds.has(ownerWebContents.id)) {
      sftpAuthorizationCleanupOwnerIds.add(ownerWebContents.id);
      ownerWebContents.once('destroyed', () => {
        options.sftpDownloadTargetAuthorizations.revokeOwner(ownerWebContents.id);
        sftpAuthorizationCleanupOwnerIds.delete(ownerWebContents.id);
      });
    }

    return authorizedPath;
  };

  const resolveCommit = (): string => {
    const fromEnv = process.env.COSMOSH_GIT_COMMIT ?? process.env.GIT_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA;
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      return fromEnv.trim();
    }

    const candidateWorkingDirectories = [process.cwd(), app.getAppPath()];

    for (const cwd of candidateWorkingDirectories) {
      try {
        const rawCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });

        const commit = rawCommit.trim();
        if (commit.length > 0) {
          return commit;
        }
      } catch {
        // Keep trying candidate directories until one resolves a commit.
      }
    }

    return '';
  };

  ipcMain.on('app:close-window', () => {
    const targetWindow = resolveTargetWindow(options);
    targetWindow?.close();
  });

  ipcMain.handle('app:focus-main-window', (): boolean => {
    const targetWindow = options.getMainWindow();
    if (!targetWindow) {
      return false;
    }

    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }

    targetWindow.show();
    targetWindow.focus();
    return true;
  });

  ipcMain.on('app:close-confirmation-response', (event, value: unknown) => {
    const response = parseCloseConfirmationResponse(value);
    if (!response) {
      return;
    }

    options.resolveCloseConfirmation(event.sender.id, response);
  });

  ipcMain.handle('i18n:get-locale', () => {
    return options.getLocale();
  });

  ipcMain.handle('i18n:set-locale', (_event, nextLocale: string) => {
    return options.setLocale(nextLocale);
  });

  ipcMain.handle('app:get-runtime-user-name', () => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USERNAME ?? process.env.USER ?? 'user';
    }
  });

  ipcMain.handle('app:get-version-info', async () => {
    const fullVersion = app.getVersion();
    const [version, rawBuildVersion] = fullVersion.split('+');
    const buildVersion = rawBuildVersion ?? '';
    const buildTime = await options.resolveBuildTime();
    const commit = resolveCommit();

    return {
      appName: app.getName(),
      version,
      buildVersion,
      buildTime,
      commit,
      electron: process.versions.electron ?? '',
      chromium: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      v8: process.versions.v8 ?? '',
      os: `${os.type()} ${os.arch()} ${os.release()}`,
    };
  });

  ipcMain.handle('app:get-pending-launch-working-directory', () => {
    return options.getPendingLaunchWorkingDirectory();
  });

  ipcMain.handle('app:get-downloads-path', () => {
    return app.getPath('downloads');
  });

  ipcMain.handle('app:create-sftp-temporary-file', async (event, fileName?: string): Promise<string> => {
    const localPath = await createSftpTemporaryFilePath(options, fileName);
    return authorizeSftpDownloadTarget(event.sender, localPath, true);
  });

  ipcMain.handle('app:create-sftp-downloads-file', (event, fileName?: string): string => {
    const localPath = path.join(app.getPath('downloads'), sanitizeSftpTemporaryFileName(fileName));
    return authorizeSftpDownloadTarget(event.sender, localPath, false);
  });

  ipcMain.handle('app:select-sftp-upload-files', async (): Promise<SftpUploadFileSelection> => {
    return selectAndStageSftpUploadFiles(options);
  });

  ipcMain.handle(
    'app:stage-sftp-dropped-upload-files',
    async (_event, droppedEntries?: unknown): Promise<SftpUploadFileSelection> => {
      return stageRendererDroppedSftpUploadFiles(options, droppedEntries);
    },
  );

  ipcMain.handle('app:cleanup-sftp-temporary-files', async (_event, localPaths?: unknown): Promise<boolean> => {
    return cleanupRendererStagedSftpUploadFiles(options, localPaths);
  });

  ipcMain.handle('app:open-sftp-temporary-file', async (_event, localPath?: string): Promise<boolean> => {
    const normalizedPath = await resolveExistingSftpTemporaryFilePath(options, localPath);
    const result = await shell.openPath(normalizedPath);
    if (result.length > 0) {
      throw new Error(result);
    }

    return true;
  });

  ipcMain.handle('app:read-sftp-temporary-image-preview', async (_event, localPath?: string): Promise<string> => {
    return readSftpTemporaryImagePreviewDataUrl(options, localPath);
  });

  ipcMain.handle('app:start-sftp-temporary-file-watch', async (event, localPath?: string): Promise<string> => {
    const normalizedPath = await resolveExistingSftpTemporaryFilePath(options, localPath);
    const ownerWebContents = event.sender;
    const watchId = randomUUID();
    const initialSignature = await resolveSftpTemporaryFileSignature(normalizedPath);

    const scheduleChangeCheck = (record: SftpTemporaryFileWatchRecord): void => {
      if (record.debounceTimer) {
        clearTimeout(record.debounceTimer);
      }

      record.debounceTimer = setTimeout(() => {
        record.debounceTimer = null;
        void resolveSftpTemporaryFileSignature(record.localPath)
          .then(({ signature, change }) => {
            const currentRecord = sftpTemporaryFileWatchers.get(record.watchId);
            if (!currentRecord || signature === currentRecord.lastSignature || ownerWebContents.isDestroyed()) {
              return;
            }

            currentRecord.lastSignature = signature;
            ownerWebContents.send('app:sftp-temporary-file-changed', {
              watchId: currentRecord.watchId,
              localPath: currentRecord.localPath,
              ...change,
            } satisfies SftpTemporaryFileWatchChange);
          })
          .catch(() => {
            stopSftpTemporaryFileWatcher(sftpTemporaryFileWatchers, record.watchId);
          });
      }, SFTP_TEMP_FILE_WATCH_DEBOUNCE_MS);
    };

    const watcher = watch(normalizedPath, { persistent: false }, () => {
      const record = sftpTemporaryFileWatchers.get(watchId);
      if (!record) {
        return;
      }

      scheduleChangeCheck(record);
    });

    const record: SftpTemporaryFileWatchRecord = {
      watchId,
      localPath: normalizedPath,
      ownerWebContentsId: ownerWebContents.id,
      watcher,
      debounceTimer: null,
      lastSignature: initialSignature.signature,
    };

    watcher.on('error', () => {
      stopSftpTemporaryFileWatcher(sftpTemporaryFileWatchers, watchId);
    });
    ownerWebContents.once('destroyed', () => {
      stopSftpTemporaryFileWatchersForOwner(sftpTemporaryFileWatchers, ownerWebContents.id);
    });

    sftpTemporaryFileWatchers.set(watchId, record);
    return watchId;
  });

  ipcMain.handle('app:stop-sftp-temporary-file-watch', (_event, watchId?: string): boolean => {
    return stopSftpTemporaryFileWatcher(sftpTemporaryFileWatchers, watchId);
  });

  ipcMain.handle('app:show-sftp-open-with-dialog', async (_event, localPath?: string): Promise<boolean> => {
    if (process.platform !== 'win32') {
      throw new Error('Open With dialog is only implemented on Windows.');
    }

    const normalizedPath = await resolveExistingSftpTemporaryFilePath(options, localPath);
    await openWithDialogWindows(normalizedPath);
    return true;
  });

  ipcMain.handle(
    'app:list-sftp-open-with-applications',
    async (_event, localPath?: string): Promise<SftpOpenWithApplication[]> => {
      if (process.platform !== 'darwin') {
        return [];
      }

      const normalizedPath = await resolveExistingSftpTemporaryFilePath(options, localPath);
      return listMacOsOpenWithApplications(normalizedPath);
    },
  );

  ipcMain.handle(
    'app:open-sftp-file-with-application',
    async (_event, localPath?: string, applicationPath?: string): Promise<boolean> => {
      if (process.platform !== 'darwin') {
        throw new Error('Open With application selection is only implemented on macOS.');
      }

      const normalizedPath = await resolveExistingSftpTemporaryFilePath(options, localPath);
      await openWithApplicationMacOs(normalizedPath, applicationPath);
      return true;
    },
  );

  ipcMain.handle('app:get-database-security-info', async (): Promise<DatabaseSecurityInfo> => {
    return options.getDatabaseSecurityInfo();
  });

  ipcMain.handle('app:resolve-system-proxy', async (_event, request: unknown): Promise<SystemProxyResolveResult> => {
    const targetUrl = buildSystemProxyTargetUrl(request);
    const proxyRules = await session.defaultSession.resolveProxy(targetUrl);
    return { proxyRules };
  });

  ipcMain.handle('app:open-devtools', () => {
    const targetWindow = resolveTargetWindow(options);

    if (!targetWindow || targetWindow.isDestroyed()) {
      return false;
    }

    targetWindow.webContents.openDevTools({ mode: 'detach' });
    return true;
  });

  ipcMain.handle('app:toggle-devtools', () => {
    const targetWindow = resolveTargetWindow(options);

    if (!targetWindow || targetWindow.isDestroyed()) {
      return false;
    }

    const { webContents } = targetWindow;
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
      return true;
    }

    webContents.openDevTools({ mode: 'detach' });
    return true;
  });

  ipcMain.handle('app:reload-webview', () => {
    const targetWindow = resolveTargetWindow(options);

    if (!targetWindow || targetWindow.isDestroyed()) {
      return false;
    }

    targetWindow.webContents.reloadIgnoringCache();
    return true;
  });

  ipcMain.handle('app:restart-backend-runtime', async (): Promise<boolean> => {
    if (app.isPackaged) {
      return false;
    }

    return options.restartBackendRuntime();
  });

  ipcMain.handle('app:show-in-file-manager', async (_event, targetPath?: string): Promise<boolean> => {
    const pathToOpen =
      typeof targetPath === 'string' && targetPath.trim().length > 0 ? targetPath.trim() : os.homedir();

    try {
      const stats = await fs.stat(pathToOpen);
      if (stats.isFile()) {
        shell.showItemInFolder(pathToOpen);
        return true;
      }

      const result = await shell.openPath(pathToOpen);
      return result.length === 0;
    } catch {
      return false;
    }
  });

  ipcMain.handle('app:open-external-url', async (_event, targetUrl?: string): Promise<boolean> => {
    if (typeof targetUrl !== 'string' || targetUrl.trim().length === 0) {
      return false;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl.trim());
    } catch {
      return false;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return false;
    }

    try {
      await shell.openExternal(parsedUrl.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('app:set-windows-system-menu-symbol-color', (_event, symbolColor: string): boolean => {
    return options.setWindowsSystemMenuSymbolColor(symbolColor);
  });

  ipcMain.handle(
    'app:show-save-file-dialog',
    async (event, defaultPath?: string): Promise<{ canceled: boolean; filePath?: string }> => {
      const targetWindow = resolveTargetWindow(options);
      const dialogOptions: SaveDialogOptions = {
        title: 'Save File',
        buttonLabel: 'Save',
        ...(typeof defaultPath === 'string' && defaultPath.trim().length > 0
          ? { defaultPath: defaultPath.trim() }
          : {}),
      };

      try {
        const selection = targetWindow
          ? await dialog.showSaveDialog(targetWindow, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);

        if (selection.canceled || !selection.filePath) {
          return { canceled: true };
        }

        return {
          canceled: false,
          filePath: authorizeSftpDownloadTarget(event.sender, selection.filePath, false),
        };
      } catch {
        return { canceled: true };
      }
    },
  );

  ipcMain.handle(
    'app:import-private-key',
    async (): Promise<{ canceled: boolean; fileName?: string; content?: string }> => {
      const targetWindow = resolveTargetWindow(options);

      const dialogOptions: OpenDialogOptions = {
        title: options.translateMain('dialog.importPrivateKey.title'),
        buttonLabel: options.translateMain('dialog.importPrivateKey.buttonLabel'),
        properties: ['openFile'],
        filters: [
          {
            name: options.translateMain('dialog.importPrivateKey.privateKeyFilesFilter'),
            extensions: ['pem', 'key', 'ppk', 'txt'],
          },
          {
            name: options.translateMain('dialog.importPrivateKey.allFilesFilter'),
            extensions: ['*'],
          },
        ],
      };

      try {
        const selection = targetWindow
          ? await dialog.showOpenDialog(targetWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);

        if (selection.canceled || selection.filePaths.length === 0) {
          return { canceled: true };
        }

        const selectedPath = selection.filePaths[0];
        const content = await fs.readFile(selectedPath, 'utf8');
        return {
          canceled: false,
          fileName: path.basename(selectedPath),
          content,
        };
      } catch {
        return { canceled: true };
      }
    },
  );

  ipcMain.handle('app:get-process-performance-stats', async (): Promise<ProcessPerformanceStatsPayload> => {
    return collectProcessPerformanceStats(
      resolveTargetWindow(options),
      sampleMainCpuUsagePercent,
      options.getBackendProcessId,
    );
  });

  ipcMain.handle(
    'app:export-main-heap-snapshot',
    async (): Promise<{ ok: boolean; filePath?: string; message?: string }> => {
      return exportMainProcessHeapSnapshot();
    },
  );
};
