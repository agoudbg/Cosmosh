import path from 'node:path';
import pathPosix from 'node:path/posix';

const splitCommandTokens = (command: string): string[] => {
  const tokens: string[] = [];
  const input = String(command || '');
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor] ?? '')) {
      cursor += 1;
    }

    if (cursor >= input.length) {
      break;
    }

    let token = '';
    let quote: 'single' | 'double' | null = null;

    while (cursor < input.length) {
      const char = input[cursor] ?? '';
      if (quote === 'single') {
        if (char === "'") {
          quote = null;
        } else {
          token += char;
        }
        cursor += 1;
        continue;
      }

      if (quote === 'double') {
        if (char === '"') {
          quote = null;
          cursor += 1;
          continue;
        }

        if (char === '\\' && cursor + 1 < input.length) {
          token += input[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }

        token += char;
        cursor += 1;
        continue;
      }

      if (/\s/.test(char)) {
        break;
      }

      if (char === "'") {
        quote = 'single';
        cursor += 1;
        continue;
      }

      if (char === '"') {
        quote = 'double';
        cursor += 1;
        continue;
      }

      if (char === '\\' && cursor + 1 < input.length) {
        token += input[cursor + 1] ?? '';
        cursor += 2;
        continue;
      }

      token += char;
      cursor += 1;
    }

    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
};

const resolveCdTarget = (tokens: string[]): string | null => {
  if ((tokens[0] ?? '').toLowerCase() !== 'cd') {
    return null;
  }

  const candidates = tokens.slice(1);
  const target = candidates.find((token) => token && !token.startsWith('-'));
  if (!target) {
    return '~';
  }

  if (target === '-') {
    return null;
  }

  return target;
};

/**
 * Updates local completion cwd optimistically from submitted cd commands.
 * @param currentCwd current tracked cwd.
 * @param command submitted command line.
 * @returns next tracked cwd.
 */
export const updateLocalCompletionCwd = (currentCwd: string, command: string): string => {
  const cdTarget = resolveCdTarget(splitCommandTokens(command));
  if (cdTarget === null) {
    return currentCwd;
  }

  const normalizedTarget = cdTarget.startsWith('~')
    ? path.join(process.env.HOME || currentCwd, cdTarget.slice(1))
    : cdTarget;

  if (!normalizedTarget || normalizedTarget === '~') {
    return process.env.HOME || currentCwd;
  }

  return path.isAbsolute(normalizedTarget)
    ? path.normalize(normalizedTarget)
    : path.normalize(path.resolve(currentCwd, normalizedTarget));
};

/**
 * Updates remote completion cwd optimistically from submitted cd commands.
 * @param currentCwd current tracked remote cwd.
 * @param command submitted command line.
 * @returns next tracked remote cwd.
 */
export const updateRemoteCompletionCwd = (
  currentCwd: string | null,
  command: string,
  options?: { homeDirectory?: string | null },
): string | null => {
  const cdTarget = resolveCdTarget(splitCommandTokens(command));
  if (cdTarget === null) {
    return currentCwd;
  }

  const homeDirectory = options?.homeDirectory?.trim() || null;

  if (cdTarget === '~') {
    return homeDirectory ? pathPosix.normalize(homeDirectory) : currentCwd;
  }

  if (cdTarget.startsWith('/')) {
    return pathPosix.normalize(cdTarget);
  }

  if (cdTarget.startsWith('~/')) {
    return homeDirectory ? pathPosix.normalize(pathPosix.join(homeDirectory, cdTarget.slice(2))) : currentCwd;
  }

  if (!currentCwd) {
    return currentCwd;
  }

  return pathPosix.normalize(pathPosix.resolve(currentCwd, cdTarget));
};

/**
 * Replays submitted commands once the initial remote cwd becomes available.
 * @param baseCwd initial remote cwd resolved from prompt or fallback probe.
 * @param commands submitted commands captured before cwd was known.
 * @param options optional home directory used for `cd` and `cd ~/...` targets.
 * @returns cwd after applying replayable directory transitions.
 */
export const replayRemoteCompletionCwdCommands = (
  baseCwd: string | null,
  commands: readonly string[],
  options?: { homeDirectory?: string | null },
): string | null => {
  return commands.reduce<string | null>(
    (currentCwd, command) => updateRemoteCompletionCwd(currentCwd, command, options),
    baseCwd,
  );
};

/**
 * Extracts remote cwd from common shell prompt tails.
 * @param outputTail normalized prompt/output tail.
 * @param currentCwd current tracked cwd used as fallback.
 * @param homeDirectory remote home directory used for `~` prompt fragments.
 * @returns parsed cwd or null when prompt does not expose cwd.
 */
export const resolveRemotePromptCwd = (
  outputTail: string,
  currentCwd: string | null,
  homeDirectory?: string | null,
): string | null => {
  const lines = outputTail
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidateLine = lines[index] ?? '';
    const hostPromptMatch = /:[\s]*([^\s]+)\s*[#$]$/.exec(candidateLine);
    const plainPromptMatch = /^([^\s]+)\s*[#$]$/.exec(candidateLine);
    const candidate = hostPromptMatch?.[1] ?? plainPromptMatch?.[1] ?? '';
    if (!candidate) {
      continue;
    }

    const normalizedHomeDirectory = homeDirectory?.trim() || null;
    if (candidate === '~') {
      return normalizedHomeDirectory ? pathPosix.normalize(normalizedHomeDirectory) : currentCwd;
    }

    if (candidate.startsWith('~/')) {
      return normalizedHomeDirectory
        ? pathPosix.normalize(pathPosix.join(normalizedHomeDirectory, candidate.slice(2)))
        : currentCwd;
    }

    if (!candidate.startsWith('/')) {
      continue;
    }

    return pathPosix.normalize(candidate);
  }

  return null;
};
