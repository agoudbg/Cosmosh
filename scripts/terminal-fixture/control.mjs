import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtureDirectory = path.join(workspace, ".cosmosh", "terminal-fixture");
const configPath = path.join(fixtureDirectory, "connection.json");
const owner = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
const containerName = `cosmosh-terminal-fixture-${owner}`;
const imageName = `cosmosh-terminal-fixture:${owner}`;
const runtime = process.env.COSMOSH_FIXTURE_RUNTIME ?? "docker";
if (!["docker", "podman"].includes(runtime)) {
  throw new Error("COSMOSH_FIXTURE_RUNTIME must be docker or podman.");
}

/**
 * Run a container command without passing arguments through a shell.
 * @param {string[]} args Container CLI arguments.
 * @param {boolean} inherit Whether to stream build output.
 * @returns {string} Captured output, or an empty string for streamed commands.
 */
function container(args, inherit = false) {
  const command = process.platform === "win32" ? "wsl.exe" : runtime;
  const commandArgs =
    process.platform === "win32"
      ? [
          "-d",
          process.env.COSMOSH_FIXTURE_WSL_DISTRO ?? "Debian",
          "--exec",
          runtime,
          ...args,
        ]
      : args;
  return (
    execFileSync(command, commandArgs, {
      encoding: "utf8",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    }) ?? ""
  );
}

/**
 * Convert host paths for the container runtime used by this host.
 * @param {string} filePath Absolute host path.
 * @returns {string} Runtime-visible path.
 */
function runtimePath(filePath) {
  if (process.platform !== "win32") return filePath;
  return execFileSync(
    "wsl.exe",
    [
      "-d",
      process.env.COSMOSH_FIXTURE_WSL_DISTRO ?? "Debian",
      "--exec",
      "wslpath",
      "-a",
      filePath,
    ],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
}

/**
 * Generate only fixture-owned keys; retain them between runs for reproducibility.
 * @param {string} name Key basename under the private fixture directory.
 * @returns {string} Absolute private-key path.
 */
function ensureKey(name) {
  const keyPath = path.join(fixtureDirectory, name);
  if (!existsSync(keyPath)) {
    execFileSync(
      "ssh-keygen",
      [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "cosmosh-test-only",
        "-f",
        keyPath,
      ],
      {
        stdio: "pipe",
        timeout: 10_000,
      },
    );
  }
  return keyPath;
}

/**
 * Wait for the loopback SSH listener, with a fixed startup deadline.
 * @param {number} port Published loopback port.
 * @returns {Promise<void>} Resolves once the fixture accepts a TCP connection.
 */
async function waitForListener(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const listening = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (ready) => {
        socket.destroy();
        resolve(ready);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    "Fixture SSH listener did not become ready within 20 seconds.",
  );
}

/**
 * Read only the container that belongs to this checkout.
 * @returns {object | null} Docker-compatible inspect data, or null when absent.
 */
function inspectContainer() {
  const ids = container([
    "ps",
    "-a",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.ID}}",
  ]).trim();
  if (!ids) return null;
  const inspected = JSON.parse(container(["inspect", containerName]))[0];
  if (inspected?.Config?.Labels?.["dev.cosmosh.terminal-fixture"] !== owner) {
    throw new Error(
      "Refusing to manage a container without this checkout fixture label.",
    );
  }
  return inspected;
}

/**
 * Start an isolated OpenSSH server with pinned host identity and temporary accounts.
 * @returns {Promise<void>} Completes after the connection file is usable.
 */
async function start() {
  const existing = inspectContainer();
  if (existing) {
    if (existing.State?.Running && existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      await waitForListener(config.port);
      console.log(`Fixture already running: ${configPath}`);
      return;
    }
    throw new Error(
      "A stopped or incomplete fixture exists; run terminal:fixture stop first.",
    );
  }
  mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
  const clientKey = ensureKey("id_ed25519");
  const hostKey = ensureKey("ssh_host_ed25519_key");
  container(
    [
      "build",
      "-t",
      imageName,
      "-f",
      runtimePath(
        path.join(workspace, "scripts/terminal-fixture/Containerfile"),
      ),
      runtimePath(path.join(workspace, "scripts/terminal-fixture")),
    ],
    true,
  );
  const publicKey = readFileSync(`${hostKey}.pub`, "utf8")
    .trim()
    .split(/\s+/u)[1];
  const hostFingerprint = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex");
  let created = false;
  try {
    container([
      "create",
      "--name",
      containerName,
      "--label",
      `dev.cosmosh.terminal-fixture=${owner}`,
      "--publish",
      "127.0.0.1::22",
      "--mount",
      `type=bind,src=${runtimePath(`${clientKey}.pub`)},dst=/run/fixture-authorized-keys,readonly`,
      "--mount",
      `type=bind,src=${runtimePath(hostKey)},dst=/run/fixture-host-key,readonly`,
      imageName,
    ]);
    created = true;
    container(["start", containerName]);
    const mapping = container(["port", containerName, "22/tcp"]).trim();
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(mapping);
    if (!match)
      throw new Error(
        `Expected a loopback-only port mapping, received ${mapping}`,
      );
    const port = Number(match[1]);
    await waitForListener(port);
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          host: "127.0.0.1",
          port,
          privateKeyPath: clientKey,
          hostFingerprint,
          containerName,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(`Fixture ready: ${configPath}`);
  } catch (error) {
    if (created) {
      try {
        container(["rm", "--force", containerName]);
      } catch (cleanupError) {
        console.error("Fixture cleanup failed:", cleanupError.message);
      }
    }
    throw error;
  }
}

/**
 * Stop only this checkout's labeled container and remove its connection descriptor.
 * @returns {void}
 */
function stop() {
  if (inspectContainer()) container(["rm", "--force", containerName]);
  if (existsSync(configPath)) unlinkSync(configPath);
  console.log("Terminal fixture stopped.");
}

const action = process.argv[2];
if (action === "start") await start();
else if (action === "stop") stop();
else if (action === "status")
  console.log(
    JSON.stringify(inspectContainer()?.State ?? { Running: false }, null, 2),
  );
else throw new Error("Usage: pnpm terminal:fixture <start|stop|status>");
