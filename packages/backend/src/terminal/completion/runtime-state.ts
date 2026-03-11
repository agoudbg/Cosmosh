import path from 'node:path';
import pathPosix from 'node:path/posix';

const SECRET_PROMPT_MAX_ACTIVE_MS = 45_000;
const SECRET_PROMPT_TAIL_MAX_LENGTH = 1_024;

const SECRET_PROMPT_PATTERNS: RegExp[] = [
  /\[\s*sudo\s*\]\s*password(?: for [^:]+)?:\s*$/i,
  /(?:^|\s)password(?: for [^:]+)?:\s*$/i,
  /enter passphrase(?: for key [^:]+)?:\s*$/i,
];

const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC_PATTERN = new RegExp(`${ESCAPE_CHAR}\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`, 'g');

export type CompletionPromptState = {
  outputTail: string;
  promptDetectedAtMs: number;
  shouldSuggestSecret: boolean;
};

const stripAnsiCodes = (value: string): string => {
  return value.replace(ANSI_OSC_PATTERN, '').replace(ANSI_ESCAPE_PATTERN, '');
};

const normalizeTail = (value: string): string => {
  const withoutAnsi = stripAnsiCodes(value);
  const normalizedLineBreaks = withoutAnsi.replace(/\r/g, '\n');
  if (normalizedLineBreaks.length <= SECRET_PROMPT_TAIL_MAX_LENGTH) {
    return normalizedLineBreaks;
  }

  return normalizedLineBreaks.slice(-SECRET_PROMPT_TAIL_MAX_LENGTH);
};

/**
 * Detects interactive secret prompts from terminal output chunks.
 * @param state mutable prompt state bound to one terminal session.
 * @param outputChunk newly received terminal output.
 * @param nowMs monotonic timestamp from Date.now().
 * @returns updated prompt state.
 */
export const updatePromptStateFromOutput = (
  state: CompletionPromptState,
  outputChunk: string,
  nowMs: number,
): CompletionPromptState => {
  const nextTail = normalizeTail(`${state.outputTail}${outputChunk}`);
  const tailLines = nextTail.split(/\n/);
  const lastVisibleLine = (tailLines[tailLines.length - 1] ?? '').trim();
  const hasPrompt = SECRET_PROMPT_PATTERNS.some((pattern) => pattern.test(lastVisibleLine));

  if (!hasPrompt) {
    const stillActive = state.shouldSuggestSecret && nowMs - state.promptDetectedAtMs <= SECRET_PROMPT_MAX_ACTIVE_MS;
    return {
      outputTail: nextTail,
      promptDetectedAtMs: stillActive ? state.promptDetectedAtMs : 0,
      shouldSuggestSecret: stillActive,
    };
  }

  return {
    outputTail: nextTail,
    promptDetectedAtMs: nowMs,
    shouldSuggestSecret: true,
  };
};

/**
 * Clears prompt suggestion state when user submits input line.
 * @param state mutable prompt state bound to one terminal session.
 * @param inputData raw terminal input payload.
 * @returns updated prompt state.
 */
export const updatePromptStateFromInput = (state: CompletionPromptState, inputData: string): CompletionPromptState => {
  if (!state.shouldSuggestSecret) {
    return state;
  }

  if (!/\r|\n/.test(inputData)) {
    return state;
  }

  return {
    outputTail: state.outputTail,
    promptDetectedAtMs: 0,
    shouldSuggestSecret: false,
  };
};

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
export const updateRemoteCompletionCwd = (currentCwd: string | null, command: string): string | null => {
  const cdTarget = resolveCdTarget(splitCommandTokens(command));
  if (cdTarget === null || !currentCwd) {
    return currentCwd;
  }

  if (cdTarget === '~') {
    return currentCwd;
  }

  if (cdTarget.startsWith('/')) {
    return pathPosix.normalize(cdTarget);
  }

  if (cdTarget.startsWith('~/')) {
    return currentCwd;
  }

  return pathPosix.normalize(pathPosix.resolve(currentCwd, cdTarget));
};

/**
 * Extracts remote cwd from common shell prompt tails.
 * @param outputTail normalized prompt/output tail.
 * @param currentCwd current tracked cwd used as fallback.
 * @returns parsed cwd or null when prompt does not expose cwd.
 */
export const resolveRemotePromptCwd = (outputTail: string, currentCwd: string | null): string | null => {
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

    if (candidate === '~' || candidate.startsWith('~/')) {
      return currentCwd;
    }

    if (!candidate.startsWith('/')) {
      continue;
    }

    return pathPosix.normalize(candidate);
  }

  return null;
};
