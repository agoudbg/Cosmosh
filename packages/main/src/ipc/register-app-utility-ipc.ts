import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';

import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';

import type { DatabaseSecurityInfo } from '../security/database-encryption';

/**
 * Dependency contract for registering app-level utility IPC handlers.
 */
export type RegisterAppUtilityIpcHandlersOptions = {
  /** Returns current main window reference (if any). */
  getMainWindow: () => BrowserWindow | null;
  /** Returns active locale used by main process. */
  getLocale: () => string;
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
  /** Applies runtime Windows title bar symbol color for system menu controls. */
  setWindowsSystemMenuSymbolColor: (symbolColor: string) => boolean;
};

/**
 * Registers shell/window/i18n utility channels exposed to renderer.
 */
export const registerAppUtilityIpcHandlers = (options: RegisterAppUtilityIpcHandlersOptions): void => {
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
    const targetWindow = BrowserWindow.getFocusedWindow() ?? options.getMainWindow();
    targetWindow?.close();
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
    const [version, buildVersion] = fullVersion.split('+');
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

  ipcMain.handle('app:get-database-security-info', async (): Promise<DatabaseSecurityInfo> => {
    return options.getDatabaseSecurityInfo();
  });

  ipcMain.handle('app:open-devtools', () => {
    if (app.isPackaged) {
      return false;
    }

    const targetWindow = BrowserWindow.getFocusedWindow() ?? options.getMainWindow();

    if (!targetWindow || targetWindow.isDestroyed()) {
      return false;
    }

    targetWindow.webContents.openDevTools({ mode: 'detach' });
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

  ipcMain.handle('app:import-private-key', async (): Promise<{ canceled: boolean; content?: string }> => {
    const targetWindow = BrowserWindow.getFocusedWindow() ?? options.getMainWindow();

    const dialogOptions: OpenDialogOptions = {
      title: 'Import Private Key',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        {
          name: 'Private Key Files',
          extensions: ['pem', 'key', 'ppk', 'txt'],
        },
        {
          name: 'All Files',
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
        content,
      };
    } catch {
      return { canceled: false };
    }
  });
};
