import backendEn from '../locales/en/backend.json';
import backendInshellisenseEn from '../locales/en/backend-inshellisense.json';
import mainEn from '../locales/en/main.json';
import rendererEn from '../locales/en/renderer.json';
import backendZhCN from '../locales/zh-CN/backend.json';
import backendInshellisenseZhCN from '../locales/zh-CN/backend-inshellisense.json';
import mainZhCN from '../locales/zh-CN/main.json';
import rendererZhCN from '../locales/zh-CN/renderer.json';

import type { Messages } from './types/i18n';

const mergeTranslationTrees = (
  baseTree: Record<string, unknown>,
  extensionTree: Record<string, unknown>,
): Record<string, unknown> => {
  const mergedTree: Record<string, unknown> = {
    ...baseTree,
  };

  Object.entries(extensionTree).forEach(([key, value]) => {
    const currentValue = mergedTree[key];

    if (
      currentValue &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      mergedTree[key] = mergeTranslationTrees(
        currentValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      return;
    }

    mergedTree[key] = value;
  });

  return mergedTree;
};

export const messages: Messages = {
  en: {
    main: mainEn,
    renderer: rendererEn,
    backend: mergeTranslationTrees(backendEn, backendInshellisenseEn) as typeof backendEn,
  },
  'zh-CN': {
    main: mainZhCN,
    renderer: rendererZhCN,
    backend: mergeTranslationTrees(backendZhCN, backendInshellisenseZhCN) as typeof backendZhCN,
  },
};
