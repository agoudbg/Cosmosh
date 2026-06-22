import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import type { ApiErrorResponse, AppMenuAction } from '@cosmosh/api-contract';
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
  shell,
  type WindowOpenHandlerResponse,
} from 'electron';
import path from 'path';

import { registerAppUtilityIpcHandlers } from './ipc/register-app-utility-ipc';
import { registerBackendIpcHandlers } from './ipc/register-backend-ipc';
import { SftpDownloadTargetAuthorizationRegistry } from './ipc/sftp-download-target-authorizations';
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
let backendStartupPromise: Promise<void> | null = null;
let backendShutdownPromise: Promise<void> | null = null;
let disableI18nHotReload: (() => void) | null = null;
let pendingLaunchWorkingDirectory: string | null = null;
const sftpDownloadTargetAuthorizations = new SftpDownloadTargetAuthorizationRegistry();

let isAppShutdownInProgress = false;

let appLocale = resolveLocale(process.env.COSMOSH_LOCALE, 'en');
const mainProcessStartedAt = Date.now();
let startupLogPath: string | null = null;
let startupLogWriteChain: Promise<void> = Promise.resolve();
let appReadyAt: number | null = null;
const mainProcessMessages = createMessages({
  en: { main: mainEn },
  'zh-CN': { main: mainZhCN },
});
const DEFAULT_RENDERER_DEV_PORT = 2767;
const MACOS_CLI_COMMAND_NAME = 'cosmosh';
const MACOS_CLI_PREFERRED_LINK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const;
const WINDOWS_TITLE_BAR_OVERLAY_COLOR = '#00000000';
const WINDOWS_TITLE_BAR_OVERLAY_HEIGHT = 50;
const DOCUMENTATION_URL = 'https://github.com/agoudbg/cosmosh/tree/main/docs';
const GITHUB_REPOSITORY_URL = 'https://github.com/agoudbg/cosmosh';
const SFTP_PROPERTIES_WINDOW_ROUTE_PARAM = 'sftp-entry-properties';
const STARTUP_LOG_DIRECTORY_NAME = 'logs';
const STARTUP_LOG_FILE_NAME = 'startup.log';
const STARTUP_LOG_MAX_BYTES = 1024 * 1024;
const STARTUP_BACKEND_REQUEST_TRACE_WINDOW_MS = 120000;

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
 * Creates the i18n instance used by main-process UI surfaces.
 */
const getMainI18n = () => {
  return createI18n({ locale: appLocale, scope: 'main', fallbackLocale: 'en', resources: mainProcessMessages });
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

/**
 * Formats elapsed startup timing in a consistent millisecond representation.
 *
 * @param startedAt Epoch millisecond timestamp captured before the measured work.
 * @returns Human-readable elapsed duration in milliseconds.
 */
const formatElapsedMs = (startedAt: number): string => {
  return `${Date.now() - startedAt}ms`;
};

/**
 * Returns the packaged-app startup log path inside userData.
 *
 * @returns Absolute log file path for main/backend startup diagnostics.
 */
const getStartupLogPath = (): string => {
  return path.join(app.getPath('userData'), STARTUP_LOG_DIRECTORY_NAME, STARTUP_LOG_FILE_NAME);
};

/**
 * Rotates a previous startup log when it grows beyond the diagnostic size cap.
 *
 * @param logFilePath Absolute startup log path.
 * @returns Promise that resolves after rotation is complete.
 */
const rotateStartupLogIfNeeded = async (logFilePath: string): Promise<void> => {
  let stats: Stats;

  try {
    stats = await fs.stat(logFilePath);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }

    throw error;
  }

  if (stats.size <= STARTUP_LOG_MAX_BYTES) {
    return;
  }

  await fs.rename(logFilePath, `${logFilePath}.1`).catch(async (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      await fs.rm(`${logFilePath}.1`, { force: true });
      await fs.rename(logFilePath, `${logFilePath}.1`);
    }
  });
};

/**
 * Initializes the startup log destination and writes a session delimiter.
 *
 * @returns Promise that resolves after the log path is ready.
 */
const initializeStartupLog = async (): Promise<void> => {
  const logFilePath = getStartupLogPath();
  await fs.mkdir(path.dirname(logFilePath), { recursive: true });
  await rotateStartupLogIfNeeded(logFilePath);
  startupLogPath = logFilePath;
  await fs.appendFile(
    logFilePath,
    `\n--- Cosmosh startup ${new Date().toISOString()} pid=${process.pid} packaged=${app.isPackaged} ---\n`,
    'utf8',
  );
};

/**
 * Appends a startup diagnostic line to the on-disk log without blocking callers.
 *
 * @param level Log severity label.
 * @param message Diagnostic message.
 * @returns void.
 */
const appendStartupLogLine = (level: 'INFO' | 'WARN' | 'ERROR', message: string): void => {
  if (!startupLogPath) {
    return;
  }

  const line = `${new Date().toISOString()} [main] [${level}] ${message}\n`;
  startupLogWriteChain = startupLogWriteChain
    .catch(() => undefined)
    .then(() => fs.appendFile(startupLogPath!, line, 'utf8'));
};

/**
 * Emits a startup diagnostic message to console and the packaged log file.
 *
 * @param message Diagnostic message.
 * @returns void.
 */
const logStartupInfo = (message: string): void => {
  console.log(message);
  appendStartupLogLine('INFO', message);
};

/**
 * Emits a warning startup diagnostic message to console and the packaged log file.
 *
 * @param message Diagnostic message.
 * @param error Optional original error for console context.
 * @returns void.
 */
const logStartupWarn = (message: string, error?: unknown): void => {
  if (error === undefined) {
    console.warn(message);
  } else {
    console.warn(message, error);
  }

  appendStartupLogLine('WARN', `${message}${error === undefined ? '' : ` ${String(error)}`}`);
};

/**
 * Emits an error startup diagnostic message to console and the packaged log file.
 *
 * @param message Diagnostic message.
 * @param error Optional original error for console context.
 * @returns void.
 */
const logStartupError = (message: string, error?: unknown): void => {
  if (error === undefined) {
    console.error(message);
  } else {
    console.error(message, error);
  }

  appendStartupLogLine('ERROR', `${message}${error === undefined ? '' : ` ${String(error)}`}`);
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

  if (backendStartupPromise) {
    const awaitExistingStartedAt = Date.now();
    await backendStartupPromise;
    logStartupInfo(
      `[startup][main] Reused in-flight backend startup after ${formatElapsedMs(awaitExistingStartedAt)}.`,
    );
    return;
  }

  backendStartupPromise = (async () => {
    const backendStartupStartedAt = Date.now();
    logStartupInfo(`[startup][main] Backend startup begin at +${Date.now() - mainProcessStartedAt}ms.`);

    const databasePathStartedAt = Date.now();
    const databasePath = getDatabasePath();
    const databaseUrl = toPrismaSqliteUrl(databasePath);
    logStartupInfo(`[startup][main] Database path resolved in ${formatElapsedMs(databasePathStartedAt)}.`);

    const token = randomBytes(32).toString('hex');
    const preparationStartedAt = Date.now();
    const portPromise = findAvailablePort().then((port) => {
      logStartupInfo(`[startup][main] Backend port reserved in ${formatElapsedMs(preparationStartedAt)}.`);
      return port;
    });
    const databaseEncryptionKeyPromise = getDatabaseEncryptionKey().then((databaseEncryptionKey) => {
      logStartupInfo(`[startup][main] Database encryption key resolved in ${formatElapsedMs(preparationStartedAt)}.`);
      return databaseEncryptionKey;
    });
    const secretKeyPromise = resolveBackendSecretKey().then((secretKey) => {
      logStartupInfo(`[startup][main] Backend secret key resolved in ${formatElapsedMs(preparationStartedAt)}.`);
      return secretKey;
    });
    const [port, databaseEncryptionKey, secretKey] = await Promise.all([
      portPromise,
      databaseEncryptionKeyPromise,
      secretKeyPromise,
    ]);
    logStartupInfo(`[startup][main] Backend preparation group completed in ${formatElapsedMs(preparationStartedAt)}.`);

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
      const devDatabaseCheckStartedAt = Date.now();
      const hasExistingDatabase = await fileExists(databasePath);
      logStartupInfo(
        `[startup][main] Development database existence check completed in ${formatElapsedMs(devDatabaseCheckStartedAt)}.`,
      );

      if (!hasExistingDatabase) {
        logStartupInfo('[backend:init] Preparing development database schema...');
        const dbPushStartedAt = Date.now();
        await runCommand('pnpm --filter @cosmosh/backend run db:push', {
          cwd: workspaceRoot,
          env: backendEnv,
          logPrefix: '[backend:init]',
          shell: true,
        });
        logStartupInfo(`[backend:init] Development database schema is ready in ${formatElapsedMs(dbPushStartedAt)}.`);
      } else {
        logStartupInfo(
          '[backend:init] Development database exists. Skipping prisma db:push to avoid encrypted DB mismatch.',
        );
      }

      const backendDevEntryPath = path.join(workspaceRoot, 'packages', 'backend', 'src', 'index.ts');
      const entryAccessStartedAt = Date.now();
      await fs.access(backendDevEntryPath);
      logStartupInfo(`[startup][main] Development backend entry verified in ${formatElapsedMs(entryAccessStartedAt)}.`);
      backendProcessCwd = path.join(workspaceRoot, 'packages', 'backend');

      // Launch backend as a direct child process to guarantee deterministic shutdown on Windows.
      // Using `pnpm run` with `shell: true` can orphan the actual runtime after app quit.
      command = process.execPath;
      args = ['--import', 'tsx', backendDevEntryPath];
      shell = false;
      backendEnv.ELECTRON_RUN_AS_NODE = '1';
      backendEnv.NODE_ENV = 'development';
    } else {
      const entryAccessStartedAt = Date.now();
      await fs.access(packagedBackendEntryPath);
      logStartupInfo(`[startup][main] Packaged backend entry verified in ${formatElapsedMs(entryAccessStartedAt)}.`);
      command = process.execPath;
      args = [packagedBackendEntryPath];
      backendProcessCwd = process.resourcesPath;
      backendEnv.ELECTRON_RUN_AS_NODE = '1';
      backendEnv.NODE_ENV = 'production';
    }

    const spawnStartedAt = Date.now();
    const spawnedBackendProcess = spawn(command, args, {
      cwd: backendProcessCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: backendEnv,
      shell,
      windowsHide: true,
    });

    backendProcess = spawnedBackendProcess;
    logStartupInfo(
      `[backend] Backend process started in ${formatElapsedMs(spawnStartedAt)} (pid=${spawnedBackendProcess.pid ?? 'unknown'}). Awaiting health check on http://127.0.0.1:${port}${API_PATHS.health}`,
    );

    spawnedBackendProcess.stdout.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        logStartupInfo(`[backend] ${message}`);
      }
    });

    spawnedBackendProcess.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message.length > 0) {
        logStartupError(`[backend] ${message}`);
      }
    });

    spawnedBackendProcess.once('exit', (code, signal) => {
      logStartupWarn(`Backend process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
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
    logStartupInfo(`[backend] Health check passed in ${formatElapsedMs(healthCheckStartedAt)}.`);
    backendPort = port;
    backendToken = token;
    logStartupInfo(
      `[startup][main] Backend startup complete in ${formatElapsedMs(backendStartupStartedAt)} at http://127.0.0.1:${port}.`,
    );
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
  const shouldTraceStartupRequest = Date.now() - mainProcessStartedAt <= STARTUP_BACKEND_REQUEST_TRACE_WINDOW_MS;
  const requestStartedAt = Date.now();
  const backendReadyStartedAt = Date.now();
  await startBackendService();

  if (shouldTraceStartupRequest) {
    logStartupInfo(
      `[startup][main] Backend ready wait for ${options.method} ${path} completed in ${formatElapsedMs(backendReadyStartedAt)}.`,
    );
  }

  const createBackendTransportError = (message: string): ApiErrorResponse => {
    return createApiError({
      code: API_CODES.commonInternalServerError,
      message,
    });
  };

  const { port, token } = requireBackendConfig();
  const headers: Record<string, string> = {
    [API_HEADERS.internalToken]: token,
    [API_HEADERS.locale]: appLocale,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const httpStartedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const responseText = await response.text();

  if (shouldTraceStartupRequest) {
    logStartupInfo(
      `[startup][main] Backend HTTP ${options.method} ${path} status=${response.status} http=${formatElapsedMs(httpStartedAt)} total=${formatElapsedMs(requestStartedAt)}.`,
    );
  }

  if (!responseText) {
    if (response.ok) {
      return createBackendTransportError(`Backend returned empty response for ${options.method} ${path}.`);
    }

    return createBackendTransportError(`Backend request failed (${response.status}) for ${options.method} ${path}.`);
  }

  try {
    return JSON.parse(responseText) as TSuccess | ApiErrorResponse;
  } catch {
    return createBackendTransportError(
      `Backend returned non-JSON response (${response.status}): ${responseText.slice(0, 180)}`,
    );
  }
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
      origin: new URL(`http://localhost:${resolveRendererDevPort()}`).origin,
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
 * Creates the primary desktop window and loads renderer entry according to runtime mode.
 */
const createWindow = async (): Promise<void> => {
  const createWindowStartedAt = Date.now();
  const isDev = !app.isPackaged;
  const preloadPath = path.join(__dirname, 'preload.js');

  logStartupInfo(`[startup][main] createWindow begin at +${Date.now() - mainProcessStartedAt}ms.`);
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

  // Load renderer based on environment
  if (isDev) {
    const rendererLoadStartedAt = Date.now();
    await mainWindow.loadURL(`http://localhost:${resolveRendererDevPort()}`);
    logStartupInfo(`[startup][main] Renderer dev URL loaded in ${formatElapsedMs(rendererLoadStartedAt)}.`);
    mainWindow.webContents.openDevTools();
  } else {
    const rendererEntryPath = path.join(process.resourcesPath, 'renderer', 'index.html');
    const rendererEntryAccessStartedAt = Date.now();
    await fs.access(rendererEntryPath);
    logStartupInfo(`[startup][main] Renderer entry verified in ${formatElapsedMs(rendererEntryAccessStartedAt)}.`);
    const rendererLoadStartedAt = Date.now();
    await mainWindow.loadFile(rendererEntryPath);
    logStartupInfo(`[startup][main] Renderer file loaded in ${formatElapsedMs(rendererLoadStartedAt)}.`);
  }

  logStartupInfo(`[startup][main] createWindow complete in ${formatElapsedMs(createWindowStartedAt)}.`);
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
      appReadyAt = Date.now();
      await initializeStartupLog();
      logStartupInfo(
        `[startup][main] Electron app ready at +${appReadyAt - mainProcessStartedAt}ms. Startup log: ${startupLogPath ?? 'unavailable'}`,
      );

      const applicationMenuStartedAt = Date.now();
      installApplicationMenu();
      logStartupInfo(`[startup][main] Application menu installed in ${formatElapsedMs(applicationMenuStartedAt)}.`);

      const cliCommandStartedAt = Date.now();
      await ensureMacOsCliCommand();
      logStartupInfo(`[startup][main] CLI command check completed in ${formatElapsedMs(cliCommandStartedAt)}.`);

      const workingDirectoryStartedAt = Date.now();
      setPendingLaunchWorkingDirectory(await resolveWorkingDirectoryFromArgv(process.argv));
      logStartupInfo(
        `[startup][main] Launch working directory resolved in ${formatElapsedMs(workingDirectoryStartedAt)}.`,
      );

      if (!app.isPackaged) {
        const i18nHotReloadStartedAt = Date.now();
        disableI18nHotReload = await enableI18nDevHotReload({
          localeRootDir: path.join(resolveWorkspaceRoot(), 'packages', 'i18n', 'locales'),
          resources: mainProcessMessages,
          scopes: ['main'],
        });
        logStartupInfo(`[startup][main] Main i18n hot reload enabled in ${formatElapsedMs(i18nHotReloadStartedAt)}.`);
      }

      const parallelStartupStartedAt = Date.now();
      const windowStartupTask = createWindow();
      const backendStartupTask = startBackendService();
      await windowStartupTask;
      logStartupInfo(`[startup][main] Window startup task resolved in ${formatElapsedMs(parallelStartupStartedAt)}.`);
      await backendStartupTask;
      logStartupInfo(`[startup][main] Backend startup task resolved in ${formatElapsedMs(parallelStartupStartedAt)}.`);
    } catch (error) {
      logStartupError('Failed to start Cosmosh application.', error);
      showStartupFailureDialog(error);
      app.quit();
      return;
    }

    logStartupInfo(`[startup][main] Main window is ready at +${Date.now() - mainProcessStartedAt}ms.`);

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
    mainWindow?.setTitle(`${!app.isPackaged ? '[D] ' : ''}${getMainI18n().t('app.title')}`);
    installApplicationMenu();
    return appLocale;
  },
  getPendingLaunchWorkingDirectory: () => pendingLaunchWorkingDirectory,
  resolveBuildTime,
  getDatabaseSecurityInfo,
  restartBackendRuntime: restartBackendService,
  getBackendProcessId: () => backendProcess?.pid ?? null,
  setWindowsSystemMenuSymbolColor,
  sftpDownloadTargetAuthorizations,
});

registerBackendIpcHandlers({
  getLocale: () => appLocale,
  ensureBackendReady: startBackendService,
  requireBackendConfig,
  requestBackend,
  consumePendingLaunchWorkingDirectory,
  sftpDownloadTargetAuthorizations,
});

// -----------------------------------------------------------------------------
// Shutdown hooks
// -----------------------------------------------------------------------------
app.on('before-quit', (event) => {
  if (isAppShutdownInProgress) {
    return;
  }

  event.preventDefault();
  isAppShutdownInProgress = true;

  void (async () => {
    disableI18nHotReload?.();
    disableI18nHotReload = null;
    await stopBackendService('electron:before-quit');
  })()
    .catch((error) => {
      console.error('[shutdown] Failed during shutdown cleanup.', error);
    })
    .finally(() => {
      app.quit();
    });
});

process.once('SIGINT', () => {
  console.warn('[shutdown] SIGINT received. Quitting application...');
  app.quit();
});

process.once('SIGTERM', () => {
  console.warn('[shutdown] SIGTERM received. Quitting application...');
  app.quit();
});

process.once('SIGBREAK', () => {
  console.warn('[shutdown] SIGBREAK received. Quitting application...');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
