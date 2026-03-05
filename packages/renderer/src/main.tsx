import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initializeLocale } from './lib/i18n';
import { initializeSettingsStore } from './lib/settings-store';

const shouldUseStrictMode = !import.meta.env.DEV || import.meta.env.VITE_ENABLE_STRICT_MODE === 'true';

document.documentElement.dataset.theme = 'dark';

const bootstrap = async (): Promise<void> => {
  await initializeLocale();
  await initializeSettingsStore();

  const appNode = <App />;

  ReactDOM.createRoot(document.getElementById('root')!).render(
    shouldUseStrictMode ? <React.StrictMode>{appNode}</React.StrictMode> : appNode,
  );
};

void bootstrap();
