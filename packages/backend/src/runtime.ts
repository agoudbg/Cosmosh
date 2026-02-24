import type { RuntimeMode } from './db/prisma.js';

/**
 * Resolves backend runtime mode from environment input.
 * Unknown values intentionally fall back to standalone mode for safer defaults.
 */
export const resolveRuntimeMode = (input: string | undefined): RuntimeMode => {
  if (input === 'electron-main') {
    return 'electron-main';
  }

  return 'standalone';
};
