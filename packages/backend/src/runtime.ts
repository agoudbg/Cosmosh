import type { RuntimeMode } from './db/prisma.js';

export const resolveRuntimeMode = (input: string | undefined): RuntimeMode => {
  if (input === 'electron-main') {
    return 'electron-main';
  }

  return 'standalone';
};
