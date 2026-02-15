import { DatabaseInitError, initializeDatabase, shutdownDatabase } from '../db/prisma.js';
import { resolveRuntimeMode } from '../runtime.js';

const run = async (): Promise<void> => {
  const runtimeMode = resolveRuntimeMode(process.env.COSMOSH_RUNTIME_MODE);

  try {
    await initializeDatabase({ runtimeMode });
    console.log(`[db:init] SQLite initialized successfully (${runtimeMode}).`);
  } catch (error: unknown) {
    if (error instanceof DatabaseInitError) {
      console.error(`[db:init][${error.code}] ${error.message}`, {
        context: error.context,
        cause: error.cause,
      });
    } else {
      console.error('[db:init][UNKNOWN] Unexpected database initialization error.', error);
    }

    process.exitCode = 1;
  } finally {
    await shutdownDatabase();
  }
};

void run();
