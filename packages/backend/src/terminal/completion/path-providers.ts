import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pathPosix from 'node:path/posix';

import type { TerminalPathCompletionContext, TerminalPathEntry } from './types.js';

const MAX_REMOTE_SCAN_ENTRIES = 200;

type PreparedPathLookup = {
  lookupDirectory: string;
  typedDirectoryPrefix: string;
  fragment: string;
};

type PathFlavor = 'local' | 'remote';

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const startsWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'");
  const startsWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"');
  return startsWithSingle || startsWithDouble ? trimmed.slice(1, -1) : trimmed;
};

const scorePathMatch = (fragment: string, candidate: string, fuzzyMatch: boolean): number => {
  const normalizedFragment = fragment.toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();
  if (!normalizedFragment) {
    return 300;
  }

  if (normalizedCandidate.startsWith(normalizedFragment)) {
    return 1_000 - Math.min(120, normalizedCandidate.length - normalizedFragment.length);
  }

  if (normalizedCandidate.includes(normalizedFragment)) {
    return 700 - Math.min(150, normalizedCandidate.length - normalizedFragment.length);
  }

  if (!fuzzyMatch) {
    return 0;
  }

  let fragmentIndex = 0;
  let candidateIndex = 0;
  let gapPenalty = 0;

  while (fragmentIndex < normalizedFragment.length && candidateIndex < normalizedCandidate.length) {
    if (normalizedFragment[fragmentIndex] === normalizedCandidate[candidateIndex]) {
      fragmentIndex += 1;
    } else {
      gapPenalty += 1;
    }

    candidateIndex += 1;
  }

  if (fragmentIndex < normalizedFragment.length) {
    return 0;
  }

  return Math.max(180, 320 - gapPenalty);
};

const buildPathEntryLabel = (lookup: PreparedPathLookup, entry: TerminalPathEntry): string => {
  const suffix = entry.kind === 'directory' ? '/' : '';
  return `${lookup.typedDirectoryPrefix}${entry.name}${suffix}`;
};

const dedupeByName = (entries: TerminalPathEntry[]): TerminalPathEntry[] => {
  const result: TerminalPathEntry[] = [];
  const seen = new Set<string>();

  entries.forEach((entry) => {
    const key = `${entry.kind}:${entry.name}`;
    if (!entry.name || seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(entry);
  });

  return result;
};

const rankPathEntries = (
  entries: TerminalPathEntry[],
  lookup: PreparedPathLookup,
  context: TerminalPathCompletionContext,
): TerminalPathEntry[] => {
  return dedupeByName(entries)
    .filter((entry) => !context.directoriesOnly || entry.kind === 'directory')
    .map((entry) => ({
      entry,
      score: scorePathMatch(lookup.fragment, entry.name, context.fuzzyMatch),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.entry.kind !== right.entry.kind) {
        return left.entry.kind === 'directory' ? -1 : 1;
      }

      return left.entry.name.localeCompare(right.entry.name);
    })
    .slice(0, context.limit)
    .map((item) => ({
      name: buildPathEntryLabel(lookup, item.entry),
      kind: item.entry.kind,
    }));
};

const preparePathLookup = (
  partialPath: string,
  baseDirectory: string,
  flavor: PathFlavor,
): PreparedPathLookup | null => {
  const normalizedPartialPath = stripWrappingQuotes(partialPath);
  const modulePath = flavor === 'remote' ? pathPosix : path;
  const separatorPattern = flavor === 'remote' ? /\// : /[\\/]/;

  const expandedPartialPath =
    flavor === 'local' && normalizedPartialPath.startsWith('~')
      ? `${os.homedir()}${normalizedPartialPath.slice(1)}`
      : normalizedPartialPath;

  if (!expandedPartialPath) {
    return {
      lookupDirectory: baseDirectory,
      typedDirectoryPrefix: '',
      fragment: '',
    };
  }

  if (expandedPartialPath === '.') {
    return {
      lookupDirectory: baseDirectory,
      typedDirectoryPrefix: './',
      fragment: '',
    };
  }

  if (expandedPartialPath === '..') {
    return {
      lookupDirectory: modulePath.dirname(baseDirectory),
      typedDirectoryPrefix: '../',
      fragment: '',
    };
  }

  const trailingSeparator = separatorPattern.test(expandedPartialPath.slice(-1));
  const absoluteCandidate = modulePath.isAbsolute(expandedPartialPath)
    ? modulePath.normalize(expandedPartialPath)
    : modulePath.resolve(baseDirectory, expandedPartialPath || '.');

  const lookupDirectory = trailingSeparator ? absoluteCandidate : modulePath.dirname(absoluteCandidate);
  const fragment = trailingSeparator ? '' : modulePath.basename(absoluteCandidate);

  const rawDirectoryPrefixLength = Math.max(0, normalizedPartialPath.length - fragment.length);
  const typedDirectoryPrefix = normalizedPartialPath.slice(0, rawDirectoryPrefixLength);

  return {
    lookupDirectory,
    typedDirectoryPrefix,
    fragment,
  };
};

/**
 * Creates a path completion provider for local terminal sessions.
 * @param cwd session-scoped working directory used as base for relative paths.
 * @returns provider function consumed by completion engine.
 */
export const createLocalPathProvider =
  (cwd: string) =>
  async (context: TerminalPathCompletionContext): Promise<TerminalPathEntry[]> => {
    const lookup = preparePathLookup(context.partialPath, cwd, 'local');
    if (!lookup) {
      return [];
    }

    try {
      const entries = await readdir(lookup.lookupDirectory, { withFileTypes: true });
      const mappedEntries: TerminalPathEntry[] = entries
        .filter((entry) => entry.name !== '.' && entry.name !== '..')
        .map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : 'file',
        }));

      return rankPathEntries(mappedEntries, lookup, context);
    } catch {
      return [];
    }
  };

const escapeSingleQuotedForSh = (value: string): string => {
  return value.replace(/'/g, "'\"'\"'");
};

/**
 * Creates a path completion provider for SSH sessions backed by separate exec channels.
 * @param options helper callbacks to fetch and execute remote directory scans.
 * @returns provider function consumed by completion engine.
 */
export const createRemotePathProvider = (options: {
  resolveCwd: () => Promise<string | null>;
  executeCommand: (command: string) => Promise<string>;
}) => {
  return async (context: TerminalPathCompletionContext): Promise<TerminalPathEntry[]> => {
    const cwd = await options.resolveCwd();
    if (!cwd) {
      return [];
    }

    const lookup = preparePathLookup(context.partialPath, cwd, 'remote');
    if (!lookup) {
      return [];
    }

    const escapedDirectory = escapeSingleQuotedForSh(lookup.lookupDirectory);
    const command = `sh -lc 'set +e; dir='"'"'${escapedDirectory}'"'"'; count=0; for p in "$dir"/* "$dir"/.*; do [ -e "$p" ] || continue; name=$(basename -- "$p" 2>/dev/null || basename "$p"); [ "$name" = "." ] && continue; [ "$name" = ".." ] && continue; if [ -d "$p" ]; then printf "D\t%s\n" "$name"; else printf "F\t%s\n" "$name"; fi; count=$((count+1)); if [ "$count" -ge ${MAX_REMOTE_SCAN_ENTRIES} ]; then break; fi; done'`;

    try {
      const output = await options.executeCommand(command);
      const mappedEntries: TerminalPathEntry[] = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 2 && line.includes('\t'))
        .map((line) => {
          const [type, ...parts] = line.split('\t');
          const name = parts.join('\t').trim();
          return {
            name,
            kind: type === 'D' ? 'directory' : 'file',
          } as TerminalPathEntry;
        })
        .filter((entry) => entry.name.length > 0);

      return rankPathEntries(mappedEntries, lookup, context);
    } catch {
      return [];
    }
  };
};
