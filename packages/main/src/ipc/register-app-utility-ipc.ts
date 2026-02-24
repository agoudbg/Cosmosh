import fs from 'node:fs/promises';
import os from 'node:os';

import { app, BrowserWindow, ipcMain, shell } from 'electron';

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
};

/**
 * Registers shell/window/i18n utility channels exposed to renderer.
 */
export const registerAppUtilityIpcHandlers = (options: RegisterAppUtilityIpcHandlersOptions): void => {
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

    return {
      appName: app.getName(),
      version,
      buildVersion,
      buildTime,
    };
  });

  ipcMain.handle('app:get-pending-launch-working-directory', () => {
    return options.getPendingLaunchWorkingDirectory();
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
};
