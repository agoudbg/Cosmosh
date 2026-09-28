import { posix } from 'node:path';

import type {
  ShellEditorSnapshot,
  ShellEditorTarget,
  ShellPathQueryRequest,
  ShellPathQueryResult,
} from '@cosmosh/api-contract';

import { prepareRemotePathQuery } from './remote-path-query.js';
import {
  buildShellCompletionReplacement,
  parseShellCompletionContext,
  quoteShellPath,
  type ShellCompletionDraft,
} from './snapshot-edits.js';

/** Snapshot-only path source; literal filenames never enter the legacy raw PTY insertion protocol. */
export type SnapshotPathResult = {
  status: ShellPathQueryResult['status'] | 'unsupported';
  drafts: ShellCompletionDraft[];
};

/**
 * Builds exact quoted path edits from one actual editor snapshot and its confirmed original-Shell directory.
 * The owning session checks permission/identity before invoking and before binding returned candidates.
 * @param shell Actual original Shell. @param snapshot Private full input and same-observation directory metadata.
 * @param query Permission-scoped cancellable structured directory source. @param options Bounded matching preferences.
 * @returns Quoted draft edits, or an explicit unavailable/unsupported/failed source status.
 */
export const resolveSnapshotPaths = async (
  shell: ShellEditorTarget['shell'],
  snapshot: ShellEditorSnapshot,
  query: (request: ShellPathQueryRequest) => Promise<ShellPathQueryResult>,
  options: { fuzzyMatch: boolean; limit: number },
): Promise<SnapshotPathResult> => {
  if (!snapshot.buffer || !snapshot.directory) return { status: 'unavailable', drafts: [] };
  const context = parseShellCompletionContext(shell, snapshot.buffer);
  if (!context) return { status: 'unsupported', drafts: [] };
  // A bare command name is resolved through PATH, not through the directory being listed.
  if (
    context.wordIndex === 0 &&
    !context.word.prefix.includes('/') &&
    !(context.word.homeRelative && context.word.prefix === '~')
  )
    return { status: 'unsupported', drafts: [] };
  const navigation = ['cd', 'pushd'].includes(context.words[0]);
  // Wrappers, option forms and Zsh's two-argument cd require a separate semantic parser.
  if (
    ['builtin', 'command', 'noglob', 'nocorrect'].includes(context.words[0]) ||
    (navigation && (context.wordIndex !== 1 || context.words.length !== 2))
  )
    return { status: 'unsupported', drafts: [] };
  const lookup = prepareRemotePathQuery(context.word, snapshot.directory, {
    ...options,
    directoriesOnly: context.wordIndex === 1 && ['cd', 'pushd', 'rmdir'].includes(context.words[0]),
  });
  if (!lookup) return { status: 'unavailable', drafts: [] };
  if (navigation) {
    // cd can normalize parents logically and search CDPATH. Only leading relative parents
    // from an identical logical/physical CWD have a provable meaning without reading Shell options.
    const components = lookup.insertPrefix.split('/').filter(Boolean);
    if (components.includes('..')) {
      if (
        lookup.insertPrefix.startsWith('/') ||
        snapshot.directory.logical !== snapshot.directory.physical ||
        components.some(
          (component, index) =>
            component === '..' && components.slice(0, index).some((parent) => parent !== '.' && parent !== '..'),
        )
      )
        return { status: 'unsupported', drafts: [] };
      lookup.request.directory = posix.resolve(lookup.request.directory);
    }
    // Display and insert the same explicit source path, so CDPATH cannot redirect the selection.
    const absolutePrefix = lookup.request.directory.replace(/\/$/u, '') + '/';
    lookup.displayPrefix = absolutePrefix;
    lookup.insertPrefix = absolutePrefix;
  }
  const result = await query(lookup.request);
  if (result.status !== 'ok' && result.status !== 'partial') return { status: result.status, drafts: [] };
  const drafts: ShellCompletionDraft[] = [];
  for (const entry of result.entries) {
    const suffix = entry.name + (entry.kind === 'directory' ? '/' : '');
    const text = quoteShellPath(shell, lookup.insertPrefix + suffix);
    if (text === null) continue;
    const edit = { start: context.word.start, end: context.word.end, text };
    if (!buildShellCompletionReplacement(snapshot.buffer, edit)) continue;
    drafts.push({ label: lookup.displayPrefix + suffix, detail: null, source: 'runtime', kind: 'path', edit });
  }
  return { status: result.status, drafts };
};
