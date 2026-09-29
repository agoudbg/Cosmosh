import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(
  workspace,
  "packages/remote-bootstrap/native/bash/cosmosh_bash.c",
);
const builder = path.join(workspace, "scripts/bash-native");
const output = path.join(
  workspace,
  "packages/remote-bootstrap/internal/nativeassets/assets",
);
const stampPath = path.join(output, ".build-stamp.json");
const architectures = ["amd64", "arm64"];
const ifStale = process.argv.slice(2).join(" ") === "--if-stale";

/** @param {string} command Executable name. @param {string[]} args Arguments. @returns {Promise<string>} Captured stdout. */
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`${command} failed with exit code ${code}`)),
    );
  });

/** @param {string} hostPath Host path. @returns {Promise<string>} Path visible inside WSL and Docker. */
const dockerPath = async (hostPath) =>
  process.platform === "win32"
    ? await run("wsl.exe", [
        "-d",
        process.env.COSMOSH_FIXTURE_WSL_DISTRO ?? "Debian",
        "--exec",
        "wslpath",
        "-a",
        hostPath,
      ])
    : hostPath;

/** @param {string[]} args Docker arguments. @returns {Promise<void>} Completes after Docker succeeds. */
const docker = async (args) => {
  const command = process.platform === "win32" ? "wsl.exe" : "docker";
  const prefix =
    process.platform === "win32"
      ? [
          "-d",
          process.env.COSMOSH_FIXTURE_WSL_DISTRO ?? "Debian",
          "--exec",
          "docker",
        ]
      : [];
  await run(command, [...prefix, ...args]);
};

/** @param {string} filePath File to hash. @returns {Promise<string>} SHA-256 digest. */
const sha256 = async (filePath) =>
  createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");

const main = async () => {
  const inputs = [
    source,
    path.join(builder, "Containerfile"),
    path.join(builder, "build.sh"),
  ];
  const inputHash = createHash("sha256");
  for (const input of inputs) inputHash.update(await fs.readFile(input));
  const key = inputHash.digest("hex");
  if (ifStale) {
    try {
      const stamp = JSON.parse(await fs.readFile(stampPath, "utf8"));
      if (
        stamp.key === key &&
        (
          await Promise.all(
            architectures.map(
              async (arch) =>
                (await sha256(
                  path.join(output, `cosmosh-bash-linux-${arch}.so`),
                )) === stamp.assets?.[arch],
            ),
          )
        ).every(Boolean)
      ) {
        console.log(
          "Bash native modules match source and builder; reusing checked assets.",
        );
        return;
      }
    } catch {
      // Missing or incomplete cache entries are rebuilt and verified.
    }
  }
  await fs.mkdir(output, { recursive: true });
  const image = "cosmosh-bash-native:bullseye-v1";
  await docker([
    "build",
    "--pull=false",
    "-t",
    image,
    "-f",
    await dockerPath(path.join(builder, "Containerfile")),
    await dockerPath(builder),
  ]);
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=bind,src=${await dockerPath(source)},dst=/source/cosmosh_bash.c,readonly`,
    "--mount",
    `type=bind,src=${await dockerPath(output)},dst=/out`,
    image,
  ]);
  const nextKey = createHash("sha256");
  for (const input of inputs) nextKey.update(await fs.readFile(input));
  if (nextKey.digest("hex") !== key)
    throw new Error("Bash native source changed during build");
  const assets = Object.fromEntries(
    await Promise.all(
      architectures.map(async (arch) => [
        arch,
        await sha256(path.join(output, `cosmosh-bash-linux-${arch}.so`)),
      ]),
    ),
  );
  await fs.writeFile(
    stampPath,
    `${JSON.stringify({ key, assets }, null, 2)}\n`,
  );
};

await main();
