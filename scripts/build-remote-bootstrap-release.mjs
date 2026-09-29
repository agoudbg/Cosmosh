import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(workspaceRoot, "packages", "remote-bootstrap");
const outputDir = path.join(packageRoot, "dist");
const defaultRepository = process.env.GITHUB_REPOSITORY ?? "agoudbg/cosmosh";
const defaultTag =
  process.env.GITHUB_REF_NAME ??
  process.env.COSMOSH_RELEASE_TAG ??
  "v0.0.0-dev";
const repository = (
  process.env.COSMOSH_REMOTE_BOOTSTRAP_RELEASE_REPOSITORY ?? defaultRepository
).trim();
const releaseTag = (
  process.env.COSMOSH_REMOTE_BOOTSTRAP_RELEASE_TAG ?? defaultTag
).trim();
const manifestVersion = (
  process.env.COSMOSH_REMOTE_BOOTSTRAP_MANIFEST_VERSION ??
  releaseTag.replace(/^v/, "")
).trim();
const releaseAssetBaseUrl = (
  process.env.COSMOSH_REMOTE_BOOTSTRAP_RELEASE_ASSET_BASE_URL ??
  `https://github.com/${repository}/releases/download/${releaseTag}`
).replace(/\/+$/, "");
const manifestVersionPattern = /^[A-Za-z0-9._+-]+$/;

const targets = [
  { os: "linux", arch: "amd64", goarch: "amd64" },
  { os: "linux", arch: "arm64", goarch: "arm64" },
];

/**
 * Renders a shell-safe command string for logs.
 *
 * @param command Executable name.
 * @param args Command arguments.
 * @returns Human-readable command line.
 */
const renderCommand = (command, args) => [command, ...args].join(" ");

/**
 * Runs one child process and streams output to the current terminal.
 *
 * @param command Executable name.
 * @param args Command arguments.
 * @param options Process options.
 * @returns Resolves when the command succeeds.
 */
const runCommand = async (command, args, options) => {
  console.log(`[remote-bootstrap:release] ${renderCommand(command, args)}`);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Remote bootstrap build command failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${renderCommand(
            command,
            args,
          )}`,
        ),
      );
    });
  });
};

/**
 * Calculates a lowercase SHA-256 digest for one file.
 *
 * @param filePath Absolute file path.
 * @returns Lowercase hex SHA-256 digest.
 */
const calculateSha256 = async (filePath) => {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
};

/**
 * Builds all release-target bootstrap binaries.
 *
 * @returns Manifest asset descriptors for the generated binaries.
 */
const buildAssets = async () => {
  await runCommand(
    process.execPath,
    [path.join(scriptDir, "build-shell-native.mjs")],
    {
      cwd: workspaceRoot,
      env: process.env,
    },
  );
  if (process.platform === "linux")
    await runCommand(
      "go",
      [
        "test",
        "-tags=cosmosh_native",
        "./internal/install",
        "./internal/nativeassets",
      ],
      {
        cwd: packageRoot,
        env: process.env,
      },
    );
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const assets = [];
  for (const target of targets) {
    const fileName = `cosmosh-remote-bootstrap-${target.os}-${target.arch}`;
    const outputPath = path.join(outputDir, fileName);
    await runCommand(
      "go",
      [
        "build",
        "-tags=cosmosh_native",
        "-trimpath",
        "-ldflags=-s -w",
        "-o",
        outputPath,
        "./cmd/cosmosh-bootstrap",
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOOS: target.os,
          GOARCH: target.goarch,
        },
      },
    );

    const sha256 = await calculateSha256(outputPath);
    assets.push({
      os: target.os,
      arch: target.arch,
      url: `${releaseAssetBaseUrl}/${fileName}`,
      sha256,
    });
  }

  return assets;
};

/**
 * Writes the manifest used by backend remote bootstrap orchestration.
 *
 * @param assets Manifest asset descriptors.
 * @returns Absolute manifest path.
 */
const writeManifest = async (assets) => {
  const manifestPath = path.join(
    outputDir,
    "cosmosh-remote-bootstrap-manifest.json",
  );
  const manifest = {
    version: manifestVersion,
    assets,
  };
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`[remote-bootstrap:release] Wrote manifest: ${manifestPath}`);
  return manifestPath;
};

/**
 * Builds remote bootstrap assets and manifest for release or CI channels.
 *
 * @returns Resolves when all files have been generated.
 */
const main = async () => {
  if (!releaseTag.trim()) {
    throw new Error(
      "Release tag is required to build remote bootstrap manifest URLs.",
    );
  }
  if (!manifestVersionPattern.test(manifestVersion)) {
    throw new Error(
      "Remote bootstrap manifest version must contain only letters, digits, dots, underscores, plus signs, or hyphens.",
    );
  }
  if (new URL(releaseAssetBaseUrl).protocol !== "https:") {
    throw new Error("Remote bootstrap asset base URL must use HTTPS.");
  }

  const assets = await buildAssets();
  await writeManifest(assets);
};

main().catch((error) => {
  console.error("[remote-bootstrap:release] Failed.", error);
  process.exitCode = 1;
});
