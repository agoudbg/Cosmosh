import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';

import type {
  ApiErrorResponse,
  ApiSettingsGetResponse,
  ApiSettingsUpdateRequest,
  ApiSettingsUpdateResponse,
  ApiSshCreateFolderRequest,
  ApiSshCreateFolderResponse,
  ApiSshCreateServerRequest,
  ApiSshCreateServerResponse,
  ApiSshCreateSessionHostVerificationRequiredResponse,
  ApiSshCreateSessionRequest,
  ApiSshCreateSessionResponse,
  ApiSshCreateTagRequest,
  ApiSshCreateTagResponse,
  ApiSshGetServerCredentialsResponse,
  ApiSshListFoldersResponse,
  ApiSshListServersResponse,
  ApiSshListTagsResponse,
  ApiSshTrustFingerprintRequest,
  ApiSshTrustFingerprintResponse,
  ApiSshUpdateFolderRequest,
  ApiSshUpdateFolderResponse,
  ApiSshUpdateServerRequest,
  ApiSshUpdateServerResponse,
  ApiTestPingResponse,
} from '@cosmosh/api-contract';
import { API_CODES, API_HEADERS, API_PATHS, createApiError } from '@cosmosh/api-contract';
import { createI18n, enableI18nDevHotReload, resolveLocale } from '@cosmosh/i18n';
import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';

import { getDatabaseEncryptionKey, getDatabasePath, toPrismaSqliteUrl } from './security/database-encryption';

type LocalTerminalProfile = {
  id: string;
  name: string;
  command: string;
  executablePath: string;
  args: string[];
};

type LocalTerminalListResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    items: LocalTerminalProfile[];
  };
};

type LocalTerminalCreateSessionRequest = {
  profileId: string;
  cols: number;
  rows: number;
  term: string;
};

type LocalTerminalCreateSessionResponse = {
  success: true;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  data: {
    sessionId: string;
    profileId: string;
    websocketUrl: string;
    websocketToken: string;
  };
};
let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendPort: number | null = null;
let backendToken: string | null = null;
let disableI18nHotReload: (() => void) | null = null;

let appLocale = resolveLocale(process.env.COSMOSH_LOCALE, 'en');
const DEFAULT_RENDERER_DEV_PORT = 2767;

const resolveRendererDevPort = (): number => {
  const candidate = Number(process.env.COSMOSH_RENDERER_DEV_PORT ?? DEFAULT_RENDERER_DEV_PORT);
  if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535) {
    return DEFAULT_RENDERER_DEV_PORT;
  }

  return candidate;
};

const getMainI18n = () => {
  return createI18n({ locale: appLocale, scope: 'main', fallbackLocale: 'en' });
};

const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const formatStartupError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown startup error.';
  }
};

const showStartupFailureDialog = (error: unknown): void => {
  const summary = formatStartupError(error);
  const message = [
    'Cosmosh failed to start backend services and will now quit.',
    '',
    `Reason: ${summary}`,
    '',
    'Please run a freshly built package and check startup logs for details.',
  ].join('\n');

  dialog.showErrorBox('Cosmosh Startup Failed', message);
};

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main process.', error);
  showStartupFailureDialog(error);
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process.', reason);
  showStartupFailureDialog(reason);
  app.quit();
});

const runCommand = async (
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPrefix: string;
    shell: boolean;
  },
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    console.log(`${options.logPrefix} Starting command: ${command}`);

    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      console.log(`${options.logPrefix} ${chunk.toString().trim()}`);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      console.error(`${options.logPrefix} ${chunk.toString().trim()}`);
    });

    child.once('error', (error) => {
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        console.log(`${options.logPrefix} Command completed successfully.`);
        resolve();
        return;
      }

      reject(new Error(`Command exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  });
};

const resolveWorkspaceRoot = (): string => {
  return path.resolve(__dirname, '../../..');
};

const resolveDataRootDir = (): string => {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }

  if (process.env.XDG_DATA_HOME) {
    return process.env.XDG_DATA_HOME;
  }

  return path.join(os.homedir(), '.local', 'share');
};

const hardenSecretKeyPermissions = async (secretFilePath: string): Promise<void> => {
  if (process.platform === 'win32') {
    return;
  }

  await fs.chmod(secretFilePath, 0o600);
};

const resolveBackendSecretKey = async (): Promise<string> => {
  const storageDirPath = path.join(resolveDataRootDir(), 'Cosmosh', 'backend', 'storage');
  const secretFilePath = path.join(storageDirPath, 'secret.key');

  try {
    const existing = (await fs.readFile(secretFilePath, 'utf8')).trim();
    if (existing.length >= 32) {
      await hardenSecretKeyPermissions(secretFilePath);
      return existing;
    }
  } catch {
    // Generate a new secret when file does not exist or is unreadable.
  }

  const generated = randomBytes(32).toString('hex');
  await fs.mkdir(storageDirPath, { recursive: true });
  await fs.writeFile(secretFilePath, generated, { encoding: 'utf8', mode: 0o600 });
  await hardenSecretKeyPermissions(secretFilePath);
  return generated;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const findAvailablePort = async (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to resolve available port for backend server.'));
        return;
      }

      const { port } = address;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
};

const waitForBackendReady = async (port: number, isProcessAlive: () => boolean, timeoutMs = 30000): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive()) {
      throw new Error('Backend process exited before health check became ready.');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}${API_PATHS.health}`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore transient startup errors.
    }

    await wait(200);
  }

  throw new Error(`Backend service startup timeout after ${timeoutMs}ms (port=${port}).`);
};

const startBackendService = async (): Promise<void> => {
  if (backendProcess && backendPort && backendToken) {
    return;
  }

  const port = await findAvailablePort();
  const token = randomBytes(32).toString('hex');
  const databasePath = getDatabasePath();
  const databaseUrl = toPrismaSqliteUrl(databasePath);
  const databaseEncryptionKey = await getDatabaseEncryptionKey();
  const secretKey = await resolveBackendSecretKey();
  const isDev = !app.isPackaged;
  const workspaceRoot = resolveWorkspaceRoot();
  const packagedBackendEntryPath = path.join(
    process.resourcesPath,
    'node_modules',
    '@cosmosh',
    'backend',
    'dist',
    'index.js',
  );
  const backendEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COSMOSH_RUNTIME_MODE: 'electron-main',
    COSMOSH_API_PORT: String(port),
    COSMOSH_INTERNAL_TOKEN: token,
    COSMOSH_SECRET_KEY: secretKey,
    COSMOSH_DB_PATH: databasePath,
    COSMOSH_DB_ENCRYPTION_KEY: databaseEncryptionKey,
    COSMOSH_USER_DATA_PATH: app.getPath('userData'),
    COSMOSH_APP_ENV: isDev ? 'development' : 'production',
    DATABASE_URL: databaseUrl,
  };

  let command: string;
  let args: string[];
  let shell = false;
  let backendProcessCwd = workspaceRoot;

  if (isDev) {
    const hasExistingDatabase = await fileExists(databasePath);

    if (!hasExistingDatabase) {
      console.log('[backend:init] Preparing development database schema...');
      await runCommand('pnpm --filter @cosmosh/backend run db:push', {
        cwd: workspaceRoot,
        env: backendEnv,
        logPrefix: '[backend:init]',
        shell: true,
      });
      console.log('[backend:init] Development database schema is ready.');
    } else {
      console.log(
        '[backend:init] Development database exists. Skipping prisma db:push to avoid encrypted DB mismatch.',
      );
    }

    command = 'pnpm --filter @cosmosh/backend exec tsx src/index.ts';
    args = [];
    shell = true;
  } else {
    await fs.access(packagedBackendEntryPath);
    command = process.execPath;
    args = [packagedBackendEntryPath];
    backendProcessCwd = process.resourcesPath;
    backendEnv.ELECTRON_RUN_AS_NODE = '1';
    backendEnv.NODE_ENV = 'production';
  }

  const spawnedBackendProcess = spawn(command, args, {
    cwd: backendProcessCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: backendEnv,
    shell,
    windowsHide: true,
  });

  backendProcess = spawnedBackendProcess;
  console.log(
    `[backend] Backend process started. Awaiting health check on http://127.0.0.1:${port}${API_PATHS.health}`,
  );

  spawnedBackendProcess.stdout.on('data', (chunk: Buffer) => {
    console.log(`[backend] ${chunk.toString().trim()}`);
  });

  spawnedBackendProcess.stderr.on('data', (chunk: Buffer) => {
    console.error(`[backend] ${chunk.toString().trim()}`);
  });

  spawnedBackendProcess.once('exit', (code, signal) => {
    console.warn(`Backend process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    backendProcess = null;
    backendPort = null;
    backendToken = null;
  });

  const healthCheckStartedAt = Date.now();
  await waitForBackendReady(port, () => spawnedBackendProcess.exitCode === null && !spawnedBackendProcess.killed);
  console.log(`[backend] Health check passed in ${Date.now() - healthCheckStartedAt}ms.`);
  backendPort = port;
  backendToken = token;
  console.log(`Backend service is ready on http://127.0.0.1:${port}`);
};

const stopBackendService = (): void => {
  if (!backendProcess) {
    return;
  }

  backendProcess.kill();
  backendProcess = null;
  backendPort = null;
  backendToken = null;
};

const requireBackendConfig = (): { port: number; token: string } => {
  if (!backendPort || !backendToken) {
    throw new Error('Backend service is not ready.');
  }

  return {
    port: backendPort,
    token: backendToken,
  };
};

const requestBackend = async <TSuccess>(
  path: string,
  options: {
    method: 'GET' | 'POST' | 'PUT';
    body?: unknown;
  },
): Promise<TSuccess | ApiErrorResponse> => {
  const { port, token } = requireBackendConfig();
  const headers: Record<string, string> = {
    [API_HEADERS.internalToken]: token,
    [API_HEADERS.locale]: appLocale,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const responseText = await response.text();

  if (!responseText) {
    if (response.ok) {
      return createApiError({
        code: API_CODES.authInvalidToken,
        message: `Backend returned empty response for ${options.method} ${path}.`,
      });
    }

    return createApiError({
      code: API_CODES.authInvalidToken,
      message: `Backend request failed (${response.status}) for ${options.method} ${path}.`,
    });
  }

  try {
    return JSON.parse(responseText) as TSuccess | ApiErrorResponse;
  } catch {
    return createApiError({
      code: API_CODES.authInvalidToken,
      message: `Backend returned non-JSON response (${response.status}): ${responseText.slice(0, 180)}`,
    });
  }
};

const createWindow = async (): Promise<void> => {
  const isDev = !app.isPackaged;
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    title: getMainI18n().t('app.title'),
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#ffffff',
            height: 30,
          },
        }),
  });

  // Load renderer based on environment
  if (isDev) {
    await mainWindow.loadURL(`http://localhost:${resolveRendererDevPort()}`);
    mainWindow.webContents.openDevTools();
  } else {
    const rendererEntryPath = path.join(process.resourcesPath, 'renderer', 'index.html');
    await fs.access(rendererEntryPath);
    await mainWindow.loadFile(rendererEntryPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      if (!app.isPackaged) {
        disableI18nHotReload = await enableI18nDevHotReload({
          localeRootDir: path.join(resolveWorkspaceRoot(), 'packages', 'i18n', 'locales'),
        });
      }

      await startBackendService();
      await createWindow();
    } catch (error) {
      console.error('Failed to start Cosmosh application.', error);
      showStartupFailureDialog(error);
      app.quit();
      return;
    }

    console.log('Main window is ready');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error) => {
          console.error('Failed to recreate main window.', error);
          showStartupFailureDialog(error);
          app.quit();
        });
      }
    });
  });
}

ipcMain.on('app:close-window', () => {
  const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;
  targetWindow?.close();
});

ipcMain.handle('i18n:get-locale', () => {
  return appLocale;
});

ipcMain.handle('i18n:set-locale', (_event, nextLocale: string) => {
  // Persisted in-memory for now; renderer fetches/updates locale through preload bridge.
  appLocale = resolveLocale(nextLocale, 'en');
  mainWindow?.setTitle(getMainI18n().t('app.title'));
  return appLocale;
});

ipcMain.handle('app:get-runtime-user-name', () => {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'user';
  }
});

ipcMain.handle('app:get-version-info', () => {
  const electronMajorVersion = Number.parseInt(process.versions.electron.split('.')[0] ?? '', 10);
  const buildVersion = Number.isFinite(electronMajorVersion) ? String(electronMajorVersion) : '0';

  return {
    appName: app.getName(),
    version: app.getVersion(),
    buildVersion,
  };
});

ipcMain.handle('app:open-devtools', () => {
  if (app.isPackaged) {
    return false;
  }

  const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

  if (!targetWindow || targetWindow.isDestroyed()) {
    return false;
  }

  targetWindow.webContents.openDevTools({ mode: 'detach' });
  return true;
});

ipcMain.handle('app:show-in-file-manager', async (_event, targetPath?: string): Promise<boolean> => {
  const pathToOpen = typeof targetPath === 'string' && targetPath.trim().length > 0 ? targetPath.trim() : os.homedir();

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

ipcMain.handle('backend:test-ping', async (): Promise<ApiTestPingResponse | ApiErrorResponse> => {
  const { port, token } = requireBackendConfig();
  const response = await fetch(`http://127.0.0.1:${port}${API_PATHS.testPing}`, {
    method: 'GET',
    headers: {
      [API_HEADERS.internalToken]: token,
      [API_HEADERS.locale]: appLocale,
    },
  });

  const payload = (await response.json()) as ApiTestPingResponse | ApiErrorResponse;

  if (!response.ok) {
    throw new Error(payload.message);
  }

  return payload;
});

ipcMain.handle('backend:settings-get', async (): Promise<ApiSettingsGetResponse | ApiErrorResponse> => {
  return requestBackend<ApiSettingsGetResponse>(API_PATHS.settingsGet, { method: 'GET' });
});

ipcMain.handle(
  'backend:settings-update',
  async (_event, payload: ApiSettingsUpdateRequest): Promise<ApiSettingsUpdateResponse | ApiErrorResponse> => {
    return requestBackend<ApiSettingsUpdateResponse>(API_PATHS.settingsUpdate, {
      method: 'PUT',
      body: payload,
    });
  },
);

ipcMain.handle('backend:ssh-list-servers', async (): Promise<ApiSshListServersResponse | ApiErrorResponse> => {
  return requestBackend<ApiSshListServersResponse>(API_PATHS.sshListServers, { method: 'GET' });
});

ipcMain.handle(
  'backend:ssh-create-server',
  async (_event, payload: ApiSshCreateServerRequest): Promise<ApiSshCreateServerResponse | ApiErrorResponse> => {
    return requestBackend<ApiSshCreateServerResponse>(API_PATHS.sshCreateServer, {
      method: 'POST',
      body: payload,
    });
  },
);

ipcMain.handle(
  'backend:ssh-update-server',
  async (
    _event,
    serverId: string,
    payload: ApiSshUpdateServerRequest,
  ): Promise<ApiSshUpdateServerResponse | ApiErrorResponse> => {
    const path = API_PATHS.sshUpdateServer.replace('{serverId}', encodeURIComponent(serverId));
    return requestBackend<ApiSshUpdateServerResponse>(path, {
      method: 'PUT',
      body: payload,
    });
  },
);

ipcMain.handle(
  'backend:ssh-get-server-credentials',
  async (_event, serverId: string): Promise<ApiSshGetServerCredentialsResponse | ApiErrorResponse> => {
    const path = API_PATHS.sshGetServerCredentials.replace('{serverId}', encodeURIComponent(serverId));
    return requestBackend<ApiSshGetServerCredentialsResponse>(path, {
      method: 'GET',
    });
  },
);

ipcMain.handle('backend:ssh-list-folders', async (): Promise<ApiSshListFoldersResponse | ApiErrorResponse> => {
  return requestBackend<ApiSshListFoldersResponse>(API_PATHS.sshListFolders, { method: 'GET' });
});

ipcMain.handle(
  'backend:ssh-create-folder',
  async (_event, payload: ApiSshCreateFolderRequest): Promise<ApiSshCreateFolderResponse | ApiErrorResponse> => {
    return requestBackend<ApiSshCreateFolderResponse>(API_PATHS.sshCreateFolder, {
      method: 'POST',
      body: payload,
    });
  },
);

ipcMain.handle(
  'backend:ssh-update-folder',
  async (
    _event,
    folderId: string,
    payload: ApiSshUpdateFolderRequest,
  ): Promise<ApiSshUpdateFolderResponse | ApiErrorResponse> => {
    const path = API_PATHS.sshUpdateFolder.replace('{folderId}', encodeURIComponent(folderId));
    return requestBackend<ApiSshUpdateFolderResponse>(path, {
      method: 'PUT',
      body: payload,
    });
  },
);

ipcMain.handle('backend:ssh-list-tags', async (): Promise<ApiSshListTagsResponse | ApiErrorResponse> => {
  return requestBackend<ApiSshListTagsResponse>(API_PATHS.sshListTags, { method: 'GET' });
});

ipcMain.handle(
  'backend:ssh-create-tag',
  async (_event, payload: ApiSshCreateTagRequest): Promise<ApiSshCreateTagResponse | ApiErrorResponse> => {
    return requestBackend<ApiSshCreateTagResponse>(API_PATHS.sshCreateTag, {
      method: 'POST',
      body: payload,
    });
  },
);

ipcMain.handle(
  'backend:ssh-create-session',
  async (
    _event,
    payload: ApiSshCreateSessionRequest,
  ): Promise<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse | ApiErrorResponse> => {
    return requestBackend<ApiSshCreateSessionResponse | ApiSshCreateSessionHostVerificationRequiredResponse>(
      API_PATHS.sshCreateSession,
      {
        method: 'POST',
        body: payload,
      },
    );
  },
);

ipcMain.handle(
  'backend:ssh-trust-fingerprint',
  async (
    _event,
    payload: ApiSshTrustFingerprintRequest,
  ): Promise<ApiSshTrustFingerprintResponse | ApiErrorResponse> => {
    return requestBackend<ApiSshTrustFingerprintResponse>(API_PATHS.sshTrustFingerprint, {
      method: 'POST',
      body: payload,
    });
  },
);

ipcMain.handle('backend:ssh-close-session', async (_event, sessionId: string): Promise<{ success: boolean }> => {
  const path = API_PATHS.sshCloseSession.replace('{sessionId}', encodeURIComponent(sessionId));
  const { port, token } = requireBackendConfig();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers: {
      [API_HEADERS.internalToken]: token,
      [API_HEADERS.locale]: appLocale,
    },
  });

  return {
    success: response.status === 204,
  };
});

ipcMain.handle('backend:ssh-delete-server', async (_event, serverId: string): Promise<{ success: boolean }> => {
  const path = API_PATHS.sshDeleteServer.replace('{serverId}', encodeURIComponent(serverId));
  const { port, token } = requireBackendConfig();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers: {
      [API_HEADERS.internalToken]: token,
      [API_HEADERS.locale]: appLocale,
    },
  });

  return {
    success: response.status === 204,
  };
});

ipcMain.handle('backend:ssh-delete-folder', async (_event, folderId: string): Promise<{ success: boolean }> => {
  const path = API_PATHS.sshDeleteFolder.replace('{folderId}', encodeURIComponent(folderId));
  const { port, token } = requireBackendConfig();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers: {
      [API_HEADERS.internalToken]: token,
      [API_HEADERS.locale]: appLocale,
    },
  });

  return {
    success: response.status === 204,
  };
});

ipcMain.handle(
  'backend:local-terminal-list-profiles',
  async (): Promise<LocalTerminalListResponse | ApiErrorResponse> => {
    return requestBackend<LocalTerminalListResponse>('/api/v1/local-terminals/profiles', {
      method: 'GET',
    });
  },
);

ipcMain.handle(
  'backend:local-terminal-create-session',
  async (
    _event,
    payload: LocalTerminalCreateSessionRequest,
  ): Promise<LocalTerminalCreateSessionResponse | ApiErrorResponse> => {
    return requestBackend<LocalTerminalCreateSessionResponse>('/api/v1/local-terminals/sessions', {
      method: 'POST',
      body: payload,
    });
  },
);

ipcMain.handle(
  'backend:local-terminal-close-session',
  async (_event, sessionId: string): Promise<{ success: boolean }> => {
    const path = `/api/v1/local-terminals/sessions/${encodeURIComponent(sessionId)}`;
    const { port, token } = requireBackendConfig();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'DELETE',
      headers: {
        [API_HEADERS.internalToken]: token,
        [API_HEADERS.locale]: appLocale,
      },
    });

    return {
      success: response.status === 204,
    };
  },
);

app.on('before-quit', () => {
  disableI18nHotReload?.();
  disableI18nHotReload = null;
  stopBackendService();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
