import { app } from 'electron';

/**
 * Installs React DevTools into Electron's default development session.
 *
 * The installer is imported lazily so packaged builds never resolve or bundle
 * this development-only dependency. Installation failures remain non-fatal
 * because offline development must still be able to start Cosmosh.
 *
 * @returns Promise resolved after React DevTools is loaded or skipped.
 */
export const loadReactDevToolsExtension = async (): Promise<void> => {
  if (app.isPackaged) {
    console.log('[debug] React DevTools extension skipped because the app is packaged.');

    return;
  }

  try {
    const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer');
    const extension = await installExtension(REACT_DEVELOPER_TOOLS);
    console.log(`[debug] Loaded React DevTools extension: ${extension.name} (${extension.id})`);
  } catch (error) {
    console.warn('[debug] Failed to load React DevTools extension.', error);
  }
};
