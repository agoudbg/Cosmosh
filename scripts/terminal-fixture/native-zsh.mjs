import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtureDirectory = path.join(workspace, ".cosmosh/terminal-fixture");
const runtime = process.env.COSMOSH_FIXTURE_RUNTIME ?? "docker";
const distribution = process.env.COSMOSH_FIXTURE_WSL_DISTRO ?? "Debian";
const builderImage = "cosmosh-shell-native:bullseye-v1";
if (!["docker", "podman"].includes(runtime))
  throw new Error("COSMOSH_FIXTURE_RUNTIME must be docker or podman.");

/**
 * Execute a bounded container command without a shell or inherited stdin.
 * @param {string[]} args Runtime arguments.
 * @param {number} timeout Maximum duration in milliseconds.
 * @param {string | undefined} input Optional reviewed Python source sent over stdin.
 * @returns {Promise<string>} Bounded stdout; failures retain their diagnostic context.
 */
async function container(args, timeout = 15_000, input) {
  const command = process.platform === "win32" ? "wsl.exe" : runtime;
  const prefix =
    process.platform === "win32" ? ["-d", distribution, "--exec", runtime] : [];
  const pending = execute(command, [...prefix, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  let inputFailure;
  pending.child.stdin.on("error", (error) => {
    inputFailure = error;
  });
  pending.child.stdin.end(input);
  const { stdout } = await pending;
  if (inputFailure)
    throw new Error("Could not deliver the native Zsh test input.", {
      cause: inputFailure,
    });
  return stdout.trim();
}

/**
 * Translate only a known checkout-owned path for WSL bind mounts.
 * @param {string} hostPath Absolute path to a test source or temporary output directory.
 * @returns {Promise<string>} Runtime-visible path.
 */
async function runtimePath(hostPath) {
  if (process.platform !== "win32") return hostPath;
  const { stdout } = await execute(
    "wsl.exe",
    ["-d", distribution, "--exec", "wslpath", "-a", hostPath],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return stdout.trim();
}

/**
 * Read the checked module without rebuilding or overwriting production artifacts.
 * @param {'amd64' | 'arm64'} architecture Fixture CPU architecture.
 * @returns {Promise<Buffer>} Exact packaged module whose source and hash match the build stamp.
 */
async function checkedModule(architecture) {
  const assetDirectory = path.join(
    workspace,
    "packages/remote-bootstrap/internal/nativeassets/assets",
  );
  const stamp = JSON.parse(
    await readFile(path.join(assetDirectory, ".build-stamp.json"), "utf8"),
  );
  const sourceHash = createHash("sha256");
  for (const source of [
    "packages/remote-bootstrap/native/bash/cosmosh_bash.c",
    "packages/remote-bootstrap/native/bash/input_order.h",
    "packages/remote-bootstrap/native/zsh/cosmosh_zsh.c",
    "scripts/shell-native/Containerfile",
    "scripts/shell-native/build.sh",
  ])
    sourceHash.update(await readFile(path.join(workspace, source)));
  const module = await readFile(
    path.join(assetDirectory, `cosmosh-zsh-linux-${architecture}.so`),
  );
  if (
    stamp.key !== sourceHash.digest("hex") ||
    stamp.assets?.[`zsh-${architecture}`] !==
      createHash("sha256").update(module).digest("hex")
  ) {
    throw new Error(
      "Zsh native assets are stale. Run node scripts/build-shell-native.mjs --if-stale before this test.",
    );
  }
  return module;
}

/**
 * Validate the disposable fixture, compile only the signal injector, and run the native PTY tests.
 * @returns {Promise<void>} Prints one JSON report after every scenario has passed and cleaned up.
 */
async function main() {
  const descriptor = JSON.parse(
    await readFile(path.join(fixtureDirectory, "connection.json"), "utf8"),
  );
  if (
    descriptor.host !== "127.0.0.1" ||
    typeof descriptor.containerName !== "string" ||
    !/^cosmosh-terminal-fixture-[a-f0-9]{12}$/u.test(descriptor.containerName)
  ) {
    throw new Error(
      "Expected the existing isolated terminal fixture connection descriptor.",
    );
  }
  const [inspection] = JSON.parse(
    await container(["inspect", descriptor.containerName]),
  );
  const owner = descriptor.containerName.slice(
    "cosmosh-terminal-fixture-".length,
  );
  if (
    !inspection?.State?.Running ||
    inspection.Config?.Labels?.["dev.cosmosh.terminal-fixture"] !== owner
  ) {
    throw new Error(
      "The fixture must be running and carry its matching ownership label.",
    );
  }
  const machine = await container([
    "exec",
    descriptor.containerName,
    "uname",
    "-m",
  ]);
  const architecture =
    machine === "x86_64" ? "amd64" : machine === "aarch64" ? "arm64" : null;
  if (!architecture)
    throw new Error(`Unsupported fixture architecture: ${machine}`);
  const executable =
    process.env.COSMOSH_FIXTURE_ZSH_EXECUTABLE ?? "/usr/bin/zsh";
  if (
    executable !== "/usr/bin/zsh" &&
    !/^\/opt\/cosmosh-fixture\/zsh-[0-9.]+\/bin\/zsh$/u.test(executable)
  ) {
    throw new Error(
      "COSMOSH_FIXTURE_ZSH_EXECUTABLE must name a fixture-owned Zsh executable.",
    );
  }
  const module = await checkedModule(architecture);
  const source = await readFile(
    path.join(workspace, "scripts/terminal-fixture/native-zsh.py"),
    "utf8",
  );
  await mkdir(fixtureDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(fixtureDirectory, "native-zsh-"));
  const compilerContainer = `cosmosh-native-zsh-${randomUUID()}`;
  let compilerStarted = false;
  try {
    compilerStarted = true;
    await container(
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        compilerContainer,
        "--network",
        "none",
        "--mount",
        `type=bind,src=${await runtimePath(path.join(workspace, "scripts/terminal-fixture/native-zsh-signal.c"))},dst=/probe.c,readonly`,
        "--mount",
        `type=bind,src=${await runtimePath(temporary)},dst=/out`,
        "--entrypoint",
        architecture === "amd64" ? "gcc" : "aarch64-linux-gnu-gcc",
        builderImage,
        "-std=c11",
        "-O2",
        "-fPIC",
        "-shared",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wl,-z,defs",
        "-Wl,-z,now",
        "-Wl,-z,relro",
        "-Wl,-z,noexecstack",
        "-o",
        "/out/signal.so",
        "/probe.c",
        "-ldl",
      ],
      30_000,
    );
    compilerStarted = false;
    const payload = JSON.stringify({
      module: module.toString("base64"),
      shim: (await readFile(path.join(temporary, "signal.so"))).toString(
        "base64",
      ),
      executable,
    });
    const report = await container(
      [
        "exec",
        "-i",
        "--user",
        "cosmosh-zsh",
        descriptor.containerName,
        "python3",
        "-",
      ],
      55_000,
      `${source}\nmain(json.loads(${JSON.stringify(payload)}))\n`,
    );
    // Return only the structured report. Compiler/container output never masquerades as a pass.
    console.log(JSON.stringify(JSON.parse(report)));
  } finally {
    try {
      if (compilerStarted) {
        const remaining = await container([
          "ps",
          "-a",
          "--filter",
          `name=^/${compilerContainer}$`,
          "--format",
          "{{.ID}}",
        ]);
        if (remaining) await container(["rm", "--force", compilerContainer]);
      }
    } finally {
      // This is the exact directory returned by mkdtemp; no shared artifact directory is removed.
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

await main();
