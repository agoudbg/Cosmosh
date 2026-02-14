import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

import type { ApiErrorResponse, ApiTestPingResponse } from '@cosmosh/api-contract';
import { API_HEADERS, API_PATHS } from '@cosmosh/api-contract';
import { createI18n, resolveLocale } from '@cosmosh/i18n';
import { spawn } from 'child_process';
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcessWithoutNullStreams | null = null;
let backendPort: number | null = null;
let backendToken: string | null = null;

let appLocale = resolveLocale(process.env.COSMOSH_LOCALE, 'en');

const getMainI18n = () => {
  return createI18n({ locale: appLocale, scope: 'main', fallbackLocale: 'en' });
};

const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const resolveWorkspaceRoot = (): string => {
  return path.resolve(__dirname, '../../..');
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

const waitForBackendReady = async (port: number, timeoutMs = 12000): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
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

  throw new Error('Backend service startup timeout.');
};

const startBackendService = async (): Promise<void> => {
  if (backendProcess && backendPort && backendToken) {
    return;
  }

  const port = await findAvailablePort();
  const token = randomBytes(32).toString('hex');
  const isDev = !app.isPackaged;
  const workspaceRoot = resolveWorkspaceRoot();

  let command: string;
  let args: string[];
  let shell = false;

  if (isDev) {
    command = 'pnpm --filter @cosmosh/backend exec tsx src/index.ts';
    args = [];
    shell = true;
  } else {
    command = process.execPath;
    args = [path.resolve(__dirname, '../../backend/dist/index.js')];
  }

  const spawnedBackendProcess = spawn(command, args, {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      COSMOSH_RUNTIME_MODE: 'electron-main',
      COSMOSH_API_PORT: String(port),
      COSMOSH_INTERNAL_TOKEN: token,
    },
    shell,
    windowsHide: true,
  });

  backendProcess = spawnedBackendProcess;

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

  await waitForBackendReady(port);
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

const createWindow = () => {
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
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  try {
    await startBackendService();
  } catch (error) {
    console.error('Failed to start backend service.', error);
    app.quit();
    return;
  }

  createWindow();
  console.log('Main window is ready');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

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

app.on('before-quit', () => {
  stopBackendService();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
