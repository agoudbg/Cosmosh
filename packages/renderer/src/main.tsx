import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initializeLocale } from './lib/i18n';

document.documentElement.dataset.theme = 'dark';

const bootstrap = async (): Promise<void> => {
  await initializeLocale();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
};

void bootstrap();
