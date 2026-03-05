import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';

import type { ApiErrorResponse } from '@cosmosh/api-contract';
import { API_CODES, API_HEADERS, API_PATHS, createApiError } from '@cosmosh/api-contract';
import { createI18n, enableI18nDevHotReload, resolveLocale } from '@cosmosh/i18n';
import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, nativeTheme } from 'electron';
import path from 'path';

import { registerAppUtilityIpcHandlers } from './ipc/register-app-utility-ipc';
import { registerBackendIpcHandlers } from './ipc/register-backend-ipc';
import {
  getDatabaseEncryptionKey,
  getDatabasePath,
  getDatabaseSecurityInfo,
  toPrismaSqliteUrl,
} from './security/database-encryption';

/**
 * Main-process singleton runtime state.
 * Electron runs a single privileged process, so this module keeps shared handles in memory.
 */
let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendPort: number | null = null;
let backendToken: string | null = null;
let disableI18nHotReload: (() => void) | null = null;
let pendingLaunchWorkingDirectory: string | null = null;

let appLocale = resolveLocale(process.env.COSMOSH_LOCALE, 'en');
const DEFAULT_RENDERER_DEV_PORT = 2767;
const MACOS_CLI_COMMAND_NAME = 'cosmosh';
const MACOS_CLI_PREFERRED_LINK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;
const WINDOWS_TITLE_BAR_OVERLAY_COLOR = '#00000000';
const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 50;

let windowsSystemMenuSymbolColor = nativeTheme.shouldUseDarkColors ? '#f5f7fa' : '#111827';

/**
 * Validates CSS color payload passed from renderer bridge.
 *
 * @param value Raw CSS color candidate.
 * @returns `true` when value is accepted as a safe overlay color.
 */
const isSupportedCssColor = (value: string): boolean => {
  return /^#(?:[\da-fA-F]{3}|[\da-fA-F]{4}|[\da-fA-F]{6}|[\da-fA-F]{8})$/.test(value);
};

/**
 * Applies Windows title bar overlay symbol color to the current main window.
 *
 * @param symbolColor Token-derived symbol color from renderer runtime.
 * @returns `true` when color is accepted and applied.
 */
const setWindowsSystemMenuSymbolColor = (symbolColor: string): boolean => {
  if (process.platform !== 'win32') {
    return false;
  }

  const normalizedColor = symbolColor.trim();
  if (!isSupportedCssColor(normalizedColor)) {
    return false;
  }

  windowsSystemMenuSymbolColor = normalizedColor;

  if (!mainWindow || mainWindow.isDestroyed()) {
    return true;
  }

  mainWindow.setTitleBarOverlay({
    color: WINDOWS_TITLE_BAR_OVERLAY_COLOR,
    symbolColor: windowsSystemMenuSymbolColor,
    height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
  });

  return true;
};

/**
 * Resolves renderer dev-server port from environment with strict numeric validation.
 */
const resolveRendererDevPort = (): number => {
  const candidate = Number(process.env.COSMOSH_RENDERER_DEV_PORT ?? DEFAULT_RENDERER_DEV_PORT);
  if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535) {
    return DEFAULT_RENDERER_DEV_PORT;
  }

  return candidate;
};

/**
 * Creates the i18n instance used by main-process UI surfaces.
 */
const getMainI18n = () => {
  return createI18n({ locale: appLocale, scope: 'main', fallbackLocale: 'en' });
};

/**
 * Removes one layer of wrapping double quotes from CLI argument values.
 */
const stripWrappingQuotes = (value: string): string => {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  return value;
};

/**
 * Scans argv and extracts working-directory argument from supported option forms.
 */
const extractWorkingDirectoryCandidate = (argv: string[]): string | null => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]?.trim() ?? '';
    if (!argument) {
      continue;
    }

    if (argument.startsWith('--working-directory=')) {
      return stripWrappingQuotes(argument.slice('--working-directory='.length));
    }

    if (argument.startsWith('--cwd=')) {
      return stripWrappingQuotes(argument.slice('--cwd='.length));
    }

    if (argument === '--working-directory' || argument === '--cwd') {
      const nextValue = argv[index + 1]?.trim();
      if (!nextValue || nextValue.startsWith('--')) {
        return null;
      }

      return stripWrappingQuotes(nextValue);
    }
  }

  return null;
};

/**
 * Resolves and validates launch working directory from command-line arguments.
 * When a file path is provided, returns its parent directory.
 */
const resolveWorkingDirectoryFromArgv = async (
  argv: string[],
  fallbackWorkingDirectory?: string,
): Promise<string | null> => {
  const fallbackCandidate =
    typeof fallbackWorkingDirectory === 'string' && fallbackWorkingDirectory.trim().length > 0
      ? stripWrappingQuotes(fallbackWorkingDirectory.trim())
      : null;
  const candidate = extractWorkingDirectoryCandidate(argv) ?? fallbackCandidate;
  if (!candidate) {
    return null;
  }

  const normalizedPath = path.resolve(candidate);

  try {
    const stats = await fs.stat(normalizedPath);
    if (stats.isDirectory()) {
      return normalizedPath;
    }

    if (stats.isFile()) {
      return path.dirname(normalizedPath);
    }
  } catch {
    // Ignore invalid launch path and fallback to default terminal cwd.
  }

  return null;
};

const setPendingLaunchWorkingDirectory = (nextPath: string | null): void => {
  pendingLaunchWorkingDirectory = nextPath;
};

/**
 * Returns one-shot launch working-directory context and clears it immediately.
 */
const consumePendingLaunchWorkingDirectory = (): string | null => {
  const current = pendingLaunchWorkingDirectory;
  pendingLaunchWorkingDirectory = null;
  return current;
};

const resolveBuildTime = async (): Promise<string> => {
  const buildTargetPath = app.isPackaged ? app.getPath('exe') : path.join(app.getAppPath(), 'package.json');

  try {
    const stats = await fs.stat(buildTargetPath);
    return stats.mtime.toISOString();
  } catch {
    return '';
  }
};

/**
 * Forwards updated launch cwd to renderer when second-instance handoff happens.
 */
const notifyRendererLaunchWorkingDirectory = (cwd: string): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:launch-working-directory', cwd);
};

/**
 * Small async sleep utility used in startup polling loops.
 */
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

/**
 * Displays a consistent fatal-startup dialog and lets users report actionable logs.
 */
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

/**
 * Resolves workspace root from emitted main-process dist location.
 */
const resolveWorkspaceRoot = (): string => {
  return path.resolve(__dirname, '../../..');
};

/**
 * Resolves platform-appropriate data root used for shared backend secrets.
 */
const resolveDataRootDir = (): string => {
  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }

  if (process.env.XDG_DATA_HOME) {
    return process.env.XDG_DATA_HOME;
  }

  return path.join(os.homedir(), '.local', 'share');
};

/**
 * Escapes a value for safe interpolation into POSIX shell single-quoted strings.
 */
const quoteForShell = (value: string): string => {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
};

const writeMacOsCliLauncherScript = async (launcherPath: string, executablePath: string): Promise<void> => {
  const scriptLines = [
    '#!/bin/sh',
    'set -eu',
    `exec ${quoteForShell(executablePath)} --working-directory "$PWD" "$@"`,
    '',
  ];

  await fs.writeFile(launcherPath, scriptLines.join('\n'), { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);
};

/**
 * Prepares a best-effort `cosmosh` CLI entrypoint on packaged macOS builds.
 */
const ensureMacOsCliCommand = async (): Promise<void> => {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return;
  }

  const userLauncherDir = path.join(app.getPath('userData'), 'bin');
  const launcherPath = path.join(userLauncherDir, MACOS_CLI_COMMAND_NAME);
  const executablePath = app.getPath('exe');

  try {
    await fs.mkdir(userLauncherDir, { recursive: true });
    await writeMacOsCliLauncherScript(launcherPath, executablePath);
  } catch (error) {
    console.warn('Failed to prepare macOS CLI launcher script.', error);
    return;
  }

  for (const linkDir of MACOS_CLI_PREFERRED_LINK_DIRS) {
    const linkPath = path.join(linkDir, MACOS_CLI_COMMAND_NAME);

    try {
      const existing = await fs.lstat(linkPath);
      if (!existing.isSymbolicLink()) {
        continue;
      }

      const linkTarget = await fs.readlink(linkPath);
      const resolvedLinkTarget = path.resolve(linkDir, linkTarget);

      if (resolvedLinkTarget === launcherPath) {
        return;
      }

      continue;
    } catch {
      // Link does not exist or is inaccessible, continue and attempt to create it.
    }

    try {
      await fs.symlink(launcherPath, linkPath);
      return;
    } catch {
      // Skip directories requiring elevated permissions.
    }
  }

  const currentPath = process.env.PATH ?? '';
  if (!currentPath.split(':').includes(userLauncherDir)) {
    console.warn(`macOS CLI command not linked to PATH. Add ${userLauncherDir} to PATH or create a symlink manually.`);
  }
};

const hardenSecretKeyPermissions = async (secretFilePath: string): Promise<void> => {
  if (process.platform === 'win32') {
    return;
  }

  await fs.chmod(secretFilePath, 0o600);
};

/**
 * Loads or creates backend secret key used for internal cryptographic operations.
 */
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

/**
 * Checks whether a file path is currently accessible.
 */
const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Reserves and returns a free localhost TCP port for backend boot.
 */
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

/**
 * Returns backend readiness timeout based on runtime mode.
 * Development mode receives a wider window to tolerate slow laptops and first-run warmup.
 */
const resolveBackendHealthCheckTimeoutMs = (isDev: boolean): number => {
  return isDev ? 60000 : 30000;
};

/**
 * Starts backend runtime and blocks until health check becomes available.
 */
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

    command = 'pnpm --filter @cosmosh/backend run dev:runtime';
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
  await waitForBackendReady(
    port,
    () => spawnedBackendProcess.exitCode === null && !spawnedBackendProcess.killed,
    resolveBackendHealthCheckTimeoutMs(isDev),
  );
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

/**
 * Restarts backend runtime in-place and refreshes active connection metadata.
 */
const restartBackendService = async (): Promise<boolean> => {
  try {
    stopBackendService();
    await startBackendService();
    return true;
  } catch (error) {
    console.error('Failed to restart backend runtime.', error);
    return false;
  }
};

/**
 * Returns backend connection state and enforces ready-state contract.
 */
const requireBackendConfig = (): { port: number; token: string } => {
  if (!backendPort || !backendToken) {
    throw new Error('Backend service is not ready.');
  }

  return {
    port: backendPort,
    token: backendToken,
  };
};

/**
 * Sends typed backend requests through internal token-authenticated HTTP transport.
 */
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

/**
 * Creates the primary desktop window and loads renderer entry according to runtime mode.
 */
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
            color: WINDOWS_TITLE_BAR_OVERLAY_COLOR,
            symbolColor: windowsSystemMenuSymbolColor,
            height: WINDOWS_TITLE_BAR_OVERLAY_HEIGHT,
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

// -----------------------------------------------------------------------------
// App lifecycle and single-instance lock
// -----------------------------------------------------------------------------
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    void resolveWorkingDirectoryFromArgv(commandLine, workingDirectory)
      .then((cwd) => {
        if (cwd) {
          setPendingLaunchWorkingDirectory(cwd);
          notifyRendererLaunchWorkingDirectory(cwd);
        }
      })
      .catch(() => {
        // Ignore malformed argv and keep current launch context.
      });

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
      await ensureMacOsCliCommand();
      setPendingLaunchWorkingDirectory(await resolveWorkingDirectoryFromArgv(process.argv));

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

// -----------------------------------------------------------------------------
// IPC channel registration
// -----------------------------------------------------------------------------
registerAppUtilityIpcHandlers({
  getMainWindow: () => mainWindow,
  getLocale: () => appLocale,
  setLocale: (nextLocale: string) => {
    appLocale = resolveLocale(nextLocale, 'en');
    mainWindow?.setTitle(getMainI18n().t('app.title'));
    return appLocale;
  },
  getPendingLaunchWorkingDirectory: () => pendingLaunchWorkingDirectory,
  resolveBuildTime,
  getDatabaseSecurityInfo,
  restartBackendRuntime: restartBackendService,
  setWindowsSystemMenuSymbolColor,
});

registerBackendIpcHandlers({
  getLocale: () => appLocale,
  requireBackendConfig,
  requestBackend,
  consumePendingLaunchWorkingDirectory,
});

// -----------------------------------------------------------------------------
// Shutdown hooks
// -----------------------------------------------------------------------------
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
