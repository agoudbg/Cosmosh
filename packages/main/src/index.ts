import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import type {
  ApiErrorResponse,
  ApiRuntimeActiveConnectionsCloseResponse,
  ApiRuntimeActiveConnectionsGetResponse,
  ApiSettingsGetResponse,
  AppMenuAction,
} from '@cosmosh/api-contract';
import { API_CODES, API_HEADERS, API_PATHS, createApiError } from '@cosmosh/api-contract';
import { createI18n, createMessages, enableI18nDevHotReload, resolveLocale } from '@cosmosh/i18n';
import mainEn from '@cosmosh/i18n/locales/en/main.json';
import mainZhCN from '@cosmosh/i18n/locales/zh-CN/main.json';
import { spawn } from 'child_process';
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  dialog,
  type HandlerDetails,
  Menu,
  nativeTheme,
  session,
  shell,
  type WindowOpenHandlerResponse,
} from 'electron';
import path from 'path';

import { DEVELOPMENT_NODE_EXECUTABLE_ENV_NAME, resolveDevelopmentBackendNodeExecutable } from './dev/backend-runtime';
import { applyDevelopmentProfileToElectronApp } from './dev/dev-profile';
import { BackendRequestTraceStore } from './ipc/backend-request-trace-store';
import { registerAppUtilityIpcHandlers } from './ipc/register-app-utility-ipc';
import { registerBackendIpcHandlers } from './ipc/register-backend-ipc';
import { registerDebugIpcHandlers } from './ipc/register-debug-ipc';
import { SftpDownloadTargetAuthorizationRegistry } from './ipc/sftp-download-target-authorizations';
import {
  cleanupSftpTemporaryRoot,
  createPrivateSftpTemporaryRoot,
  SFTP_TEMP_ROOT_ENV_NAME,
} from './ipc/sftp-temporary-root';
import { ensureMcpBridgeLauncher, resolveMcpBridgeLauncherPath } from './mcp-bridge-launcher';
import { RendererCloseConfirmationBroker } from './renderer-close-confirmation';
import {
  getDatabaseEncryptionKey,
  getDatabasePath,
  getDatabaseSecurityInfo,
  toPrismaSqliteUrl,
} from './security/database-encryption';
import { type ActiveConnectionSummary, ConnectionCloseGuard, parseActiveConnectionSummary } from './window-close-guard';

/**
 * Main-process singleton runtime state.
 * Electron runs a single privileged process, so this module keeps shared handles in memory.
 */
let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendPort: number | null = null;
let backendToken: string | null = null;
let backendStartupPromise: Promise<void> | null = null;
let backendShutdownPromise: Promise<void> | null = null;
let sftpTemporaryRootPath: string | null = null;
let disableI18nHotReload: (() => void) | null = null;
let pendingLaunchWorkingDirectory: string | null = null;
const sftpDownloadTargetAuthorizations = new SftpDownloadTargetAuthorizationRegistry();
const backendRequestTraceStore = new BackendRequestTraceStore(!app.isPackaged);
const rendererCloseConfirmationBroker = new RendererCloseConfirmationBroker({
  onError: (stage, error) => {
    console.error(`[close-confirmation] ${stage} failed.`, error);
  },
});

// Consume the internal handoff before Electron creates child processes that could inherit it.
const developmentBackendNodeExecutablePath = process.env[DEVELOPMENT_NODE_EXECUTABLE_ENV_NAME];
delete process.env[DEVELOPMENT_NODE_EXECUTABLE_ENV_NAME];

let isAppShutdownInProgress = false;
let bypassConnectionCloseGuard = false;
let allowNextMainWindowClose = false;

/**
 * Requests an immediate app quit while preserving the normal backend cleanup hook.
 *
 * @returns void.
 */
const quitWithoutConnectionWarning = (): void => {
  bypassConnectionCloseGuard = true;
  app.quit();
};

let appLocale = resolveLocale(process.env.COSMOSH_LOCALE, 'en');
const mainProcessMessages = createMessages({
  en: { main: mainEn },
  'zh-CN': { main: mainZhCN },
});
const DEFAULT_RENDERER_DEV_HOST = '127.0.0.1';
const DEFAULT_RENDERER_DEV_PORT = 2767;
const MACOS_CLI_COMMAND_NAME = 'cosmosh';
const MACOS_CLI_PREFERRED_LINK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;
const WINDOWS_TITLE_BAR_OVERLAY_COLOR = '#00000000';
const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 50;
const DOCUMENTATION_URL = 'https://github.com/agoudbg/cosmosh/tree/main/docs';
const GITHUB_REPOSITORY_URL = 'https://github.com/agoudbg/cosmosh';
const SFTP_PROPERTIES_WINDOW_ROUTE_PARAM = 'sftp-entry-properties';
const PACKAGED_REMOTE_BOOTSTRAP_MANIFEST_RESOURCE = path.join('remote-bootstrap', 'manifest-url.json');
const DEVELOPMENT_REMOTE_BOOTSTRAP_MANIFEST_URL =
  'https://github.com/agoudbg/Cosmosh/releases/download/remote-bootstrap-dev/cosmosh-remote-bootstrap-manifest.json';

type TrustedRendererWindowOpenTarget = {
  origin: string;
  pathname?: string;
};

let windowsSystemMenuSymbolColor = nativeTheme.shouldUseDarkColors ? '#f5f7fa' : '#111827';

/**
 * Sends a menu command event to renderer if a live main window exists.
 *
 * @param action Menu action identifier consumed by renderer command handlers.
 * @returns void.
 */
const sendMenuActionToRenderer = (action: AppMenuAction): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:menu-action', action);
};

/**
 * Builds and applies Electron application menu according to current platform.
 *
 * @returns void.
 */
const installApplicationMenu = (): void => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const i18n = getMainI18n();

  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: i18n.t('menu.file.label'),
    submenu: [
      {
        role: 'close',
        label: i18n.t('menu.file.closeWindow'),
      },
    ],
  };

  const editMenu: Electron.MenuItemConstructorOptions = {
    label: i18n.t('menu.edit.label'),
    submenu: [
      {
        role: 'undo',
        label: i18n.t('menu.edit.undo'),
      },
      {
        role: 'redo',
        label: i18n.t('menu.edit.redo'),
      },
      { type: 'separator' },
      {
        role: 'cut',
        label: i18n.t('menu.edit.cut'),
      },
      {
        role: 'copy',
        label: i18n.t('menu.edit.copy'),
      },
      {
        role: 'paste',
        label: i18n.t('menu.edit.paste'),
      },
      {
        role: 'pasteAndMatchStyle',
        label: i18n.t('menu.edit.pasteAndMatchStyle'),
      },
      {
        role: 'delete',
        label: i18n.t('menu.edit.delete'),
      },
      {
        role: 'selectAll',
        label: i18n.t('menu.edit.selectAll'),
      },
      { type: 'separator' },
      {
        role: 'startSpeaking',
        label: i18n.t('menu.edit.startSpeaking'),
      },
      {
        role: 'stopSpeaking',
        label: i18n.t('menu.edit.stopSpeaking'),
      },
    ],
  };

  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: i18n.t('menu.window.label'),
    submenu: [
      {
        label: i18n.t('menu.window.newTab'),
        accelerator: 'CmdOrCtrl+T',
        click: () => {
          sendMenuActionToRenderer('new-tab');
        },
      },
      {
        label: i18n.t('menu.window.closeCurrentTab'),
        accelerator: 'CmdOrCtrl+W',
        click: () => {
          sendMenuActionToRenderer('close-current-tab');
        },
      },
      {
        label: i18n.t('menu.window.closeRightTabs'),
        accelerator: 'Shift+CmdOrCtrl+W',
        click: () => {
          sendMenuActionToRenderer('close-right-tabs');
        },
      },
      {
        label: i18n.t('menu.window.switchToTab'),
        accelerator: 'CmdOrCtrl+Shift+Tab',
        click: () => {
          sendMenuActionToRenderer('show-tab-switcher');
        },
      },
      { type: 'separator' },
      {
        role: 'minimize',
        label: i18n.t('menu.window.minimize'),
      },
      {
        role: 'zoom',
        label: i18n.t('menu.window.zoom'),
      },
      {
        role: 'togglefullscreen',
        label: i18n.t('menu.window.toggleFullScreen'),
      },
      ...(process.platform === 'darwin'
        ? ([
            { type: 'separator' },
            {
              role: 'front',
              label: i18n.t('menu.window.bringAllToFront'),
            },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
    ],
  };

  const helpMenu: Electron.MenuItemConstructorOptions = {
    role: 'help',
    label: i18n.t('menu.help.label'),
    submenu: [
      {
        label: i18n.t('menu.help.documentation'),
        click: () => {
          void shell.openExternal(DOCUMENTATION_URL);
        },
      },
      {
        label: i18n.t('menu.help.githubRepository'),
        click: () => {
          void shell.openExternal(GITHUB_REPOSITORY_URL);
        },
      },
    ],
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        {
          label: i18n.t('menu.app.about', { appName: app.getName() }),
          click: () => {
            sendMenuActionToRenderer('open-about');
          },
        },
        {
          label: i18n.t('menu.app.settings'),
          accelerator: 'Command+,',
          click: () => {
            sendMenuActionToRenderer('open-settings');
          },
        },
        { type: 'separator' },
        {
          role: 'services',
          label: i18n.t('menu.app.services'),
        },
        { type: 'separator' },
        {
          role: 'hide',
          label: i18n.t('menu.app.hide', { appName: app.getName() }),
        },
        {
          role: 'hideOthers',
          label: i18n.t('menu.app.hideOthers'),
        },
        {
          role: 'unhide',
          label: i18n.t('menu.app.showAll'),
        },
        { type: 'separator' },
        {
          role: 'quit',
          label: i18n.t('menu.app.quit', { appName: app.getName() }),
        },
      ],
    },
  ];

  template.push(fileMenu, editMenu, windowMenu, helpMenu);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

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
 * Resolves the loopback URL shared by Electron and the renderer development server.
 *
 * @returns Renderer development URL with the configured port.
 */
const resolveRendererDevUrl = (): string => `http://${DEFAULT_RENDERER_DEV_HOST}:${resolveRendererDevPort()}`;

/**
 * Creates the i18n instance used by main-process UI surfaces.
 */
const getMainI18n = () => {
  return createI18n({
    locale: appLocale,
    scope: 'main',
    fallbackLocale: 'en',
    resources: mainProcessMessages,
  });
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

/**
 * Waits for a child process to exit or times out.
 *
 * @param child Child process instance.
 * @param timeoutMs Timeout in milliseconds.
 * @returns Promise resolving to true when the process exited within the timeout.
 */
const waitForChildExit = async (child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
};

/**
 * Best-effort Windows process-tree termination using `taskkill`.
 *
 * @param pid Target process id.
 * @returns Promise that resolves when `taskkill` completes.
 */
const taskkillProcessTree = async (pid: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });

    killer.once('error', (error) => {
      console.warn(`[backend:stop] Failed to spawn taskkill (pid=${pid}).`, error);
      resolve();
    });

    killer.once('exit', (code) => {
      if (code !== 0) {
        console.warn(`[backend:stop] taskkill exited with code=${code} (pid=${pid}).`);
      }
      resolve();
    });
  });
};

/**
 * Stops backend runtime and releases any database locks held by backend Prisma.
 *
 * This is intentionally defensive on Windows: when backend is launched via a tool
 * runner (pnpm/tsx), killing only the parent process can orphan the actual Node
 * runtime and keep SQLite locked. The shutdown path tries graceful termination
 * first and falls back to killing the entire process tree.
 *
 * @param origin Human-readable shutdown origin for logs.
 * @returns Promise that resolves once backend is no longer running.
 */
const stopBackendService = async (origin: string): Promise<void> => {
  if (!backendProcess) {
    return;
  }

  if (backendShutdownPromise) {
    await backendShutdownPromise;
    return;
  }

  const processToStop = backendProcess;
  const pid = processToStop.pid ?? null;

  backendShutdownPromise = (async () => {
    console.log(`[backend:stop] Stopping backend process (pid=${pid ?? 'unknown'}, origin=${origin})...`);

    try {
      const signal = process.platform === 'win32' ? 'SIGINT' : 'SIGTERM';
      processToStop.kill(signal);
    } catch (error) {
      console.warn(`[backend:stop] Failed to send graceful signal (pid=${pid ?? 'unknown'}).`, error);
    }

    const exitedGracefully = await waitForChildExit(processToStop, 4000);
    if (exitedGracefully) {
      console.log(`[backend:stop] Backend stopped gracefully (pid=${pid ?? 'unknown'}).`);
      return;
    }

    console.warn(`[backend:stop] Backend did not exit in time. Forcing termination (pid=${pid ?? 'unknown'})...`);

    if (process.platform === 'win32') {
      if (typeof pid === 'number') {
        await taskkillProcessTree(pid);
        await waitForChildExit(processToStop, 2000);
      }
      return;
    }

    try {
      processToStop.kill('SIGKILL');
    } catch (error) {
      console.warn(`[backend:stop] Failed to send SIGKILL (pid=${pid ?? 'unknown'}).`, error);
    }
  })();

  try {
    await backendShutdownPromise;
  } finally {
    backendShutdownPromise = null;
    backendProcess = null;
    backendPort = null;
    backendToken = null;
    backendStartupPromise = null;
  }
};

/**
 * Creates or returns the canonical Main-owned SFTP temp root for this app run.
 *
 * @returns Canonical private temp root path.
 */
const resolveSftpTemporaryRootPath = async (): Promise<string> => {
  if (sftpTemporaryRootPath) {
    return sftpTemporaryRootPath;
  }

  sftpTemporaryRootPath = await createPrivateSftpTemporaryRoot(app.getPath('temp'));
  return sftpTemporaryRootPath;
};

/**
 * Returns the initialized SFTP temp root required by IPC handlers.
 *
 * @returns Canonical private temp root path.
 */
const requireSftpTemporaryRootPath = (): string => {
  if (!sftpTemporaryRootPath) {
    throw new Error('SFTP temporary root is not initialized.');
  }

  return sftpTemporaryRootPath;
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
  quitWithoutConnectionWarning();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process.', reason);
  showStartupFailureDialog(reason);
  quitWithoutConnectionWarning();
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

const mainWorkspaceRoot = resolveWorkspaceRoot();
applyDevelopmentProfileToElectronApp(mainWorkspaceRoot);

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

  await fs.writeFile(launcherPath, scriptLines.join('\n'), {
    encoding: 'utf8',
    mode: 0o755,
  });
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
 * Resolves the storage directory for backend-only runtime secrets.
 *
 * @returns Absolute directory path used for backend secret material.
 */
const resolveBackendSecretStorageDir = (): string => {
  const profileStoragePath = process.env.COSMOSH_BACKEND_STORAGE_PATH?.trim();
  if (profileStoragePath) {
    return profileStoragePath;
  }

  return path.join(resolveDataRootDir(), 'Cosmosh', 'backend', 'storage');
};

/**
 * Loads or creates backend secret key used for internal cryptographic operations.
 */
const resolveBackendSecretKey = async (): Promise<string> => {
  const storageDirPath = resolveBackendSecretStorageDir();
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
  await fs.writeFile(secretFilePath, generated, {
    encoding: 'utf8',
    mode: 0o600,
  });
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
 * Reads the packaged remote bootstrap manifest URL written by CI packaging.
 *
 * Environment variables intentionally remain the first-class override, so this
 * fallback only activates for packaged artifacts that carry the resource.
 *
 * @returns Manifest URL or undefined when no packaged URL is present.
 */
const readPackagedRemoteBootstrapManifestUrl = async (): Promise<string | undefined> => {
  if (!app.isPackaged) {
    return undefined;
  }

  const resourcePath = path.join(process.resourcesPath, PACKAGED_REMOTE_BOOTSTRAP_MANIFEST_RESOURCE);
  let raw: string;
  try {
    raw = await fs.readFile(resourcePath, 'utf8');
  } catch (error: unknown) {
    const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') {
      console.warn('[backend:init] Unable to read packaged remote bootstrap manifest URL resource.', error);
    }
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as { manifestUrl?: unknown };
    if (typeof parsed.manifestUrl !== 'string' || parsed.manifestUrl.trim().length === 0) {
      return undefined;
    }

    const manifestUrl = parsed.manifestUrl.trim();
    if (new URL(manifestUrl).protocol !== 'https:') {
      console.warn('[backend:init] Ignoring packaged remote bootstrap manifest URL because it is not HTTPS.');
      return undefined;
    }

    return manifestUrl;
  } catch (error: unknown) {
    console.warn('[backend:init] Ignoring invalid packaged remote bootstrap manifest URL resource.', error);
    return undefined;
  }
};

/**
 * Starts backend runtime and blocks until health check becomes available.
 */
const startBackendService = async (): Promise<void> => {
  if (backendProcess && backendPort && backendToken) {
    return;
  }

  if (backendStartupPromise) {
    await backendStartupPromise;
    return;
  }

  backendStartupPromise = (async () => {
    const databasePath = getDatabasePath();
    const databaseUrl = toPrismaSqliteUrl(databasePath);
    const token = randomBytes(32).toString('hex');
    const [port, databaseEncryptionKey, secretKey] = await Promise.all([
      findAvailablePort(),
      getDatabaseEncryptionKey(),
      resolveBackendSecretKey(),
    ]);
    const sftpTemporaryRoot = await resolveSftpTemporaryRootPath();
    const isDev = !app.isPackaged;
    const packagedRemoteBootstrapManifestUrl = await readPackagedRemoteBootstrapManifestUrl();
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
      COSMOSH_APP_VERSION: app.getVersion(),
      [SFTP_TEMP_ROOT_ENV_NAME]: sftpTemporaryRoot,
      DATABASE_URL: databaseUrl,
    };

    if (!backendEnv.COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL) {
      backendEnv.COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_URL =
        packagedRemoteBootstrapManifestUrl ?? (isDev ? DEVELOPMENT_REMOTE_BOOTSTRAP_MANIFEST_URL : undefined);
    }

    if (app.isPackaged) {
      // The bridge launcher exists only for packaged installs; advertise its path so
      // the MCP panel can build ready-to-paste client configurations.
      backendEnv.COSMOSH_MCP_BRIDGE_LAUNCHER = resolveMcpBridgeLauncherPath({
        platform: process.platform,
        userDataPath: app.getPath('userData'),
      });
    }

    let command: string;
    let args: string[];
    let shell = false;
    let backendProcessCwd = workspaceRoot;

    if (isDev) {
      const developmentNodeExecutablePath = await resolveDevelopmentBackendNodeExecutable(
        developmentBackendNodeExecutablePath,
      );
      delete backendEnv.ELECTRON_RUN_AS_NODE;

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

      const backendDevEntryPath = path.join(workspaceRoot, 'packages', 'backend', 'src', 'index.ts');
      await fs.access(backendDevEntryPath);
      backendProcessCwd = path.join(workspaceRoot, 'packages', 'backend');

      // Launch backend as a direct child process to guarantee deterministic shutdown on Windows.
      // Using `pnpm run` with `shell: true` can orphan the actual runtime after app quit.
      command = developmentNodeExecutablePath;
      args = ['--import', 'tsx', backendDevEntryPath];
      shell = false;
      backendEnv.NODE_ENV = 'development';
      console.log(`[backend:init] Development backend runtime -> Node ${developmentNodeExecutablePath}`);
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
  })();

  try {
    await backendStartupPromise;
  } finally {
    backendStartupPromise = null;
  }
};

/**
 * Restarts backend runtime in-place and refreshes active connection metadata.
 */
const restartBackendService = async (): Promise<boolean> => {
  try {
    await stopBackendService('restart');
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

type BackendRequestRawResult = {
  status: number;
  ok: boolean;
  responseText: string;
};

/**
 * Sends a backend request through the internal token-authenticated HTTP transport and records a dev-only mirror.
 *
 * @param path Backend API path including query string.
 * @param options HTTP method and optional JSON body.
 * @returns Raw status and response text used by higher-level adapters.
 */
const requestBackendRaw = async (
  path: string,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  },
): Promise<BackendRequestRawResult> => {
  await startBackendService();

  const startedAtMs = Date.now();
  const { port, token } = requireBackendConfig();
  const headers: Record<string, string> = {
    [API_HEADERS.internalToken]: token,
    [API_HEADERS.locale]: appLocale,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const responseText = await response.text();

    backendRequestTraceStore.record({
      method: options.method,
      path,
      startedAtMs,
      requestBody: options.body,
      responseText,
      status: response.status,
      ok: response.ok,
    });

    return {
      status: response.status,
      ok: response.ok,
      responseText,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backend transport error.';
    backendRequestTraceStore.record({
      method: options.method,
      path,
      startedAtMs,
      requestBody: options.body,
      status: null,
      ok: null,
      error: message,
    });
    throw error;
  }
};

/**
 * Sends typed backend requests through internal token-authenticated HTTP transport.
 */
const requestBackend = async <TSuccess>(
  path: string,
  options: {
    method: 'DELETE' | 'GET' | 'POST' | 'PUT';
    body?: unknown;
  },
): Promise<TSuccess | ApiErrorResponse> => {
  const createBackendTransportError = (message: string): ApiErrorResponse => {
    return createApiError({
      code: API_CODES.commonInternalServerError,
      message,
    });
  };

  const response = await requestBackendRaw(path, options);

  if (!response.responseText) {
    if (response.ok) {
      return createBackendTransportError(`Backend returned empty response for ${options.method} ${path}.`);
    }

    return createBackendTransportError(`Backend request failed (${response.status}) for ${options.method} ${path}.`);
  }

  try {
    return JSON.parse(response.responseText) as TSuccess | ApiErrorResponse;
  } catch {
    return createBackendTransportError(
      `Backend returned non-JSON response (${response.status}): ${response.responseText.slice(0, 180)}`,
    );
  }
};

/**
 * Reads and validates backend-owned SSH/SFTP activity for the close guard.
 *
 * @returns Authoritative active connection counts.
 */
const readActiveConnectionSummary = async (): Promise<ActiveConnectionSummary> => {
  const response = await requestBackend<ApiRuntimeActiveConnectionsGetResponse>(API_PATHS.runtimeGetActiveConnections, {
    method: 'GET',
  });

  if (!response.success) {
    throw new Error(`Backend rejected active connection query: ${response.code}`);
  }

  const summary = parseActiveConnectionSummary(response.data);
  if (!summary) {
    throw new Error('Backend returned invalid active connection counts.');
  }

  return summary;
};

/**
 * Closes backend-owned SSH/SFTP sessions after the user approves closing.
 *
 * @returns Promise resolved after backend confirms the bulk disconnect.
 */
const closeActiveConnections = async (): Promise<void> => {
  const response = await requestBackend<ApiRuntimeActiveConnectionsCloseResponse>(
    API_PATHS.runtimeCloseActiveConnections,
    { method: 'DELETE' },
  );

  if (!response.success) {
    throw new Error(`Backend rejected active connection close: ${response.code}`);
  }

  if (!parseActiveConnectionSummary(response.data)) {
    throw new Error('Backend returned invalid closed connection counts.');
  }
};

/**
 * Reads the persisted preference that controls active-session close confirmation.
 *
 * @returns Whether Main should ask before closing active SSH/SFTP sessions.
 */
const readWindowCloseConfirmationEnabled = async (): Promise<boolean> => {
  const response = await requestBackend<ApiSettingsGetResponse>(API_PATHS.settingsGet, { method: 'GET' });
  if (!response.success) {
    throw new Error(`Backend rejected settings query: ${response.code}`);
  }

  const value = response.data.item.values.windowCloseConfirmationEnabled;
  if (typeof value !== 'boolean') {
    throw new Error('Backend returned an invalid window close confirmation preference.');
  }

  return value;
};

/**
 * Requests the shared renderer dialog while the BrowserWindow is still alive.
 *
 * @returns Whether the user approved the destructive close action.
 */
const confirmConnectionClose = async (): Promise<boolean> => {
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!targetWindow || targetWindow.webContents.isDestroyed()) {
    return rendererCloseConfirmationBroker.requestConfirmation(null);
  }

  const { webContents } = targetWindow;

  return rendererCloseConfirmationBroker.requestConfirmation({
    webContentsId: webContents.id,
    sendRequest: (request) => {
      webContents.send('app:close-confirmation-request', request);
    },
    subscribeDestroyed: (listener) => {
      webContents.once('destroyed', listener);
      return () => {
        webContents.removeListener('destroyed', listener);
      };
    },
  });
};

/**
 * Resolves the renderer target that is allowed to open app-owned popup windows.
 *
 * @param isDev Whether the renderer is served from the Vite dev server.
 * @returns Allowed renderer URL identity.
 */
const resolveTrustedRendererWindowOpenTarget = (isDev: boolean): TrustedRendererWindowOpenTarget => {
  if (isDev) {
    return {
      origin: new URL(resolveRendererDevUrl()).origin,
    };
  }

  const rendererEntryPath = path.join(process.resourcesPath, 'renderer', 'index.html');
  const rendererEntryUrl = pathToFileURL(rendererEntryPath);

  return {
    origin: rendererEntryUrl.origin,
    pathname: rendererEntryUrl.pathname,
  };
};

/**
 * Checks whether a renderer popup URL targets the SFTP properties route.
 *
 * @param details Window-open details supplied by Electron.
 * @param trustedTarget URL identity owned by the current renderer runtime.
 * @returns Whether the popup should be allowed.
 */
const isTrustedSftpPropertiesWindowOpen = (
  details: HandlerDetails,
  trustedTarget: TrustedRendererWindowOpenTarget,
): boolean => {
  try {
    const targetUrl = new URL(details.url);
    if (targetUrl.searchParams.get('cosmoshWindow') !== SFTP_PROPERTIES_WINDOW_ROUTE_PARAM) {
      return false;
    }

    if (targetUrl.origin !== trustedTarget.origin) {
      return false;
    }

    return trustedTarget.pathname === undefined || targetUrl.pathname === trustedTarget.pathname;
  } catch {
    return false;
  }
};

/**
 * Builds constrained BrowserWindow options for an app-owned SFTP properties popup.
 *
 * @param preloadPath Secure preload script path shared with the main renderer.
 * @returns BrowserWindow options merged by Electron for the child window.
 */
const createSftpPropertiesWindowOptions = (preloadPath: string): BrowserWindowConstructorOptions => {
  return {
    title: getMainI18n().t('app.title'),
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 520,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  };
};

/**
 * Installs the strict allow-list used by renderer-owned popup windows.
 *
 * @param targetWindow Main app BrowserWindow.
 * @param preloadPath Secure preload script path shared with allowed popups.
 * @param trustedTarget Renderer URL identity that may request app-owned popups.
 * @returns void.
 */
const registerRendererWindowOpenPolicy = (
  targetWindow: BrowserWindow,
  preloadPath: string,
  trustedTarget: TrustedRendererWindowOpenTarget,
): void => {
  targetWindow.webContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    if (!isTrustedSftpPropertiesWindowOpen(details, trustedTarget)) {
      return { action: 'deny' };
    }

    return {
      action: 'allow',
      overrideBrowserWindowOptions: createSftpPropertiesWindowOptions(preloadPath),
    };
  });
};

/**
 * Loads the unpacked request mirror DevTools panel in development builds.
 *
 * @returns Promise resolved after the extension is loaded or skipped.
 */
const loadBackendRequestTraceDevToolsExtension = async (): Promise<void> => {
  if (!backendRequestTraceStore.enabled) {
    console.log('[debug] Backend request trace DevTools extension skipped because the app is packaged.');

    return;
  }

  const extensionPath = path.join(mainWorkspaceRoot, 'packages', 'main', 'devtools', 'request-trace-panel');
  try {
    await fs.access(path.join(extensionPath, 'manifest.json'));
    console.log(`[debug] Loading backend request trace DevTools extension from ${extensionPath}`);
    const extension = await session.defaultSession.extensions.loadExtension(extensionPath, {
      allowFileAccess: false,
    });
    console.log(`[debug] Loaded DevTools extension: ${extension.name} (${extension.id})`);
  } catch (error) {
    console.warn('[debug] Failed to load request trace DevTools extension.', error);
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
  registerRendererWindowOpenPolicy(mainWindow, preloadPath, resolveTrustedRendererWindowOpenTarget(isDev));

  mainWindow.on('close', (event) => {
    if (isAppShutdownInProgress || allowNextMainWindowClose) {
      allowNextMainWindowClose = false;
      return;
    }

    event.preventDefault();
    void connectionCloseGuard.requestClose('window');
  });

  // Load renderer based on environment
  if (isDev) {
    await mainWindow.loadURL(resolveRendererDevUrl());
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
  quitWithoutConnectionWarning();
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
      installApplicationMenu();
      await ensureMacOsCliCommand();
      await ensureMcpBridgeLauncher({
        isPackaged: app.isPackaged,
        platform: process.platform,
        executablePath: app.getPath('exe'),
        resourcesPath: process.resourcesPath,
        userDataPath: app.getPath('userData'),
      });
      setPendingLaunchWorkingDirectory(await resolveWorkingDirectoryFromArgv(process.argv));

      if (!app.isPackaged) {
        await loadBackendRequestTraceDevToolsExtension();
        disableI18nHotReload = await enableI18nDevHotReload({
          localeRootDir: path.join(resolveWorkspaceRoot(), 'packages', 'i18n', 'locales'),
          resources: mainProcessMessages,
          scopes: ['main'],
        });
      }

      await resolveSftpTemporaryRootPath();
      const windowStartupTask = createWindow();
      const backendStartupTask = startBackendService();
      await windowStartupTask;
      await backendStartupTask;
    } catch (error) {
      console.error('Failed to start Cosmosh application.', error);
      showStartupFailureDialog(error);
      quitWithoutConnectionWarning();
      return;
    }

    console.log('Main window is ready');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error) => {
          console.error('Failed to recreate main window.', error);
          showStartupFailureDialog(error);
          quitWithoutConnectionWarning();
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
  resolveCloseConfirmation: (senderWebContentsId, response) => {
    rendererCloseConfirmationBroker.resolveConfirmation(senderWebContentsId, response);
  },
  getLocale: () => appLocale,
  translateMain: (key, params) => getMainI18n().t(key, params),
  setLocale: (nextLocale: string) => {
    appLocale = resolveLocale(nextLocale, 'en');
    mainWindow?.setTitle(`${!app.isPackaged ? '[D] ' : ''}${getMainI18n().t('app.title')}`);
    installApplicationMenu();
    return appLocale;
  },
  getPendingLaunchWorkingDirectory: () => pendingLaunchWorkingDirectory,
  resolveBuildTime,
  getDatabaseSecurityInfo,
  restartBackendRuntime: restartBackendService,
  getBackendProcessId: () => backendProcess?.pid ?? null,
  getSftpTemporaryRootPath: requireSftpTemporaryRootPath,
  setWindowsSystemMenuSymbolColor,
  sftpDownloadTargetAuthorizations,
});

registerBackendIpcHandlers({
  requestBackend,
  requestBackendRaw: async (requestPath, options) => {
    const response = await requestBackendRaw(requestPath, options);
    return { status: response.status };
  },
  consumePendingLaunchWorkingDirectory,
  sftpDownloadTargetAuthorizations,
});

registerDebugIpcHandlers({
  backendRequestTraceStore,
});

// -----------------------------------------------------------------------------
// Shutdown hooks
// -----------------------------------------------------------------------------
/**
 * Performs one idempotent application shutdown and always releases Main-owned resources.
 *
 * @returns Promise resolved after Electron receives the final quit request.
 */
const beginAppShutdown = async (): Promise<void> => {
  if (isAppShutdownInProgress) {
    return;
  }

  isAppShutdownInProgress = true;
  disableI18nHotReload?.();
  disableI18nHotReload = null;

  try {
    await stopBackendService('electron:before-quit');
  } catch (error: unknown) {
    console.error('[shutdown] Failed to stop backend service.', error);
  }

  try {
    await cleanupSftpTemporaryRoot(sftpTemporaryRootPath);
  } catch (error: unknown) {
    console.error('[shutdown] Failed to clean the SFTP temporary root.', error);
  } finally {
    sftpTemporaryRootPath = null;
  }

  app.quit();
};

const connectionCloseGuard = new ConnectionCloseGuard({
  readActiveConnections: readActiveConnectionSummary,
  readCloseConfirmationEnabled: readWindowCloseConfirmationEnabled,
  confirmClose: () => confirmConnectionClose(),
  closeActiveConnections,
  onApproved: async (intent) => {
    if (intent === 'window' && process.platform === 'darwin') {
      const targetWindow = mainWindow;
      if (targetWindow && !targetWindow.isDestroyed()) {
        allowNextMainWindowClose = true;
        targetWindow.close();
      }
      return;
    }

    await beginAppShutdown();
  },
  onError: (stage, error) => {
    console.error(`[close-guard] ${stage} failed.`, error);
  },
});

app.on('before-quit', (event) => {
  if (isAppShutdownInProgress) {
    return;
  }

  event.preventDefault();

  if (bypassConnectionCloseGuard) {
    void beginAppShutdown();
    return;
  }

  void connectionCloseGuard.requestClose('quit');
});

process.once('SIGINT', () => {
  console.warn('[shutdown] SIGINT received. Quitting application...');
  quitWithoutConnectionWarning();
});

process.once('SIGTERM', () => {
  console.warn('[shutdown] SIGTERM received. Quitting application...');
  quitWithoutConnectionWarning();
});

process.once('SIGBREAK', () => {
  console.warn('[shutdown] SIGBREAK received. Quitting application...');
  quitWithoutConnectionWarning();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
