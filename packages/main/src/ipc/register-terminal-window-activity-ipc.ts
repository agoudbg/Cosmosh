import { performance } from 'node:perf_hooks';

import { TERMINAL_WINDOW_ACTIVITY_IPC_CHANNEL } from '@cosmosh/api-contract';
import { BrowserWindow, ipcMain, shell } from 'electron';

import { TerminalWindowActivityController } from '../terminal-window-activity';

/**
 * Registers the narrow renderer-to-window terminal activity channel.
 *
 * Sender ownership is resolved from Electron's `webContents`; renderer payloads
 * cannot select or overwrite another BrowserWindow.
 *
 * @returns Nothing.
 */
export const registerTerminalWindowActivityIpcHandler = (): void => {
  const controllers = new WeakMap<BrowserWindow, TerminalWindowActivityController>();

  ipcMain.on(TERMINAL_WINDOW_ACTIVITY_IPC_CHANNEL, (event, value: unknown) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    let controller = controllers.get(targetWindow);
    if (!controller) {
      controller = new TerminalWindowActivityController(targetWindow, {
        beep: () => {
          shell.beep();
        },
        monotonicNow: () => performance.now(),
      });
      controllers.set(targetWindow, controller);
      targetWindow.on('focus', () => {
        controller?.acknowledgeWindowFocus();
      });
      targetWindow.once('closed', () => {
        controllers.delete(targetWindow);
      });
    }

    try {
      controller.apply(value);
    } catch (error: unknown) {
      console.error('[terminal-presentation] Failed to apply window activity.', error);
    }
  });
};
