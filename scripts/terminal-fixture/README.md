# Real terminal fixture

This disposable OpenSSH container owns three unprivileged accounts: `cosmosh-bash`, `cosmosh-zsh`, and `cosmosh-fish`. It never mounts a real user's home or credentials. It exposes SSH only on loopback, generates dedicated client and host keys under the ignored `.cosmosh/terminal-fixture/` directory, and pins the host fingerprint in the test client.

## Run

```sh
pnpm terminal:fixture start
pnpm test:terminal
pnpm test:terminal:live
pnpm terminal:fixture stop
```

Linux uses Docker by default. Set `COSMOSH_FIXTURE_RUNTIME=podman` to use Podman. Windows invokes the runtime in the existing Debian WSL distribution; `COSMOSH_FIXTURE_WSL_DISTRO` selects another installed distribution. No host packages or system services are installed.

The container is labeled and named per checkout. Starting an existing healthy fixture reuses it; stopping validates ownership before removing it. Always stop the fixture after verification. Private test keys remain in the ignored directory and must never be committed.

Every account contains `~/fixtures/`, with spaces, quotes, Chinese characters, emoji, a leading hyphen, a symbolic directory link, and more than 1,000 entries in `large/`. Tests use actual SSH PTYs and the installed Shell; fake Shell output is not a substitute for this suite.

The Zsh fixture also installs the distribution's `zsh-autosuggestions` and `zsh-syntax-highlighting` packages. The editor suite tests them with `compinit`, native Tab, custom prompt hooks, DEBUG traps, search/menu/recursive editors, partial keys, password readers and combining-character cursor adjustment. Read-only observations must preserve native kill/yank chaining. The development baseline is Zsh 5.9, autosuggestions 0.7.0 and syntax-highlighting 0.7.1; this does not substitute for the final supported-version matrix.

Fish tests retain the distribution's 3.6 runtime and install official Fish 4.0.1 separately under `/opt/cosmosh-fixture/fish-4.0.1/runtime`. `install_fish.py` checks the architecture-specific SHA-256 before extracting the executable and running the official installer. Rebuild a previously created fixture to obtain that runtime. Supported-editor tests explicitly disable native autosuggestions at startup; a separate test keeps them enabled and verifies native grey suggestion acceptance with precise Cosmosh editing unavailable. Key-prefix, search, selection, vi, multiline, password, history-autoload and stale-application tests exercise real PTYs.

`test:terminal:live` requires a running fixture and fails when it is missing. The ordinary unit suite does not silently count these scenarios as covered.
