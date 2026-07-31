const fs = require('node:fs/promises');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '../../..');
const bridgeBundlePath = path.join(workspaceRoot, 'packages', 'mcp-bridge', 'dist', 'cosmosh-mcp.cjs');
const helperDestinationDir = path.join(
  workspaceRoot,
  'packages',
  'main',
  'resources',
  'helpers',
  'mcp-bridge',
);
const helperDestinationPath = path.join(helperDestinationDir, 'cosmosh-mcp.cjs');

/**
 * Copies the freshly built `cosmosh-mcp` stdio-bridge bundle into the packaged
 * helpers tree so electron-builder ships it via the existing
 * `resources/helpers → helpers` extraResources mapping.
 */
const main = async () => {
  try {
    await fs.access(bridgeBundlePath);
  } catch {
    throw new Error(
      `Missing MCP bridge bundle at ${bridgeBundlePath}. Run \`pnpm --filter @cosmosh/mcp-bridge build\` first.`,
    );
  }

  await fs.mkdir(helperDestinationDir, { recursive: true });
  await fs.copyFile(bridgeBundlePath, helperDestinationPath);

  console.log(`Synced cosmosh-mcp bridge bundle → ${path.relative(workspaceRoot, helperDestinationPath)}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
