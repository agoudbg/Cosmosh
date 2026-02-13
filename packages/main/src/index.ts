import { createI18n, resolveLocale } from '@cosmosh/i18n';
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;

let appLocale = resolveLocale(process.env.COSMOSH_LOCALE, 'en');

const getMainI18n = () => {
  return createI18n({ locale: appLocale, scope: 'main', fallbackLocale: 'en' });
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

app.whenReady().then(() => {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
