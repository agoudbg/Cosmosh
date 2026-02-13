import backendEn from '../locales/en/backend.json';
import mainEn from '../locales/en/main.json';
import rendererEn from '../locales/en/renderer.json';
import backendZhCN from '../locales/zh-CN/backend.json';
import mainZhCN from '../locales/zh-CN/main.json';
import rendererZhCN from '../locales/zh-CN/renderer.json';

import type { Messages } from './types/i18n';

export const messages: Messages = {
  en: {
    main: mainEn,
    renderer: rendererEn,
    backend: backendEn,
  },
  'zh-CN': {
    main: mainZhCN,
    renderer: rendererZhCN,
    backend: backendZhCN,
  },
};
