import type { ShellDirectoryContext, ShellPathQueryRequest, ShellPathQueryResult } from '@cosmosh/api-contract';
import type { Client } from 'ssh2';

import { executeBoundedSshCommand } from '../../ssh/exec.js';
import { isEditorRecord } from '../editor-protocol.js';
import type { ShellLiteralWord } from './snapshot-edits.js';

const STATUSES = new Set<ShellPathQueryResult['status']>([
  'ok',
  'partial',
  'denied',
  'missing',
  'not-directory',
  'invalid',
  'unavailable',
  'timeout',
  'cancelled',
]);

/** Explicit SSH boundary, also used to isolate transport races in tests. */
export type RemotePathExecutor = (request: ShellPathQueryRequest, signal: AbortSignal) => Promise<ShellPathQueryResult>;
/** @param status Stable outcome. @returns An empty result without leaking raw errors or paths. */
export const emptyPathResult = (status: ShellPathQueryResult['status']): ShellPathQueryResult => ({
  status,
  entries: [],
  scanned: 0,
});

/** @param value Untrusted remote JSON. @returns A bounded normalized directory result or null. */
export const normalizePathQueryResult = (value: unknown): ShellPathQueryResult | null => {
  if (
    !isEditorRecord(value) ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status as ShellPathQueryResult['status']) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 128 ||
    !Number.isSafeInteger(value.scanned) ||
    (value.scanned as number) < 0 ||
    (value.scanned as number) > 10_000
  )
    return null;
  const entries: ShellPathQueryResult['entries'] = [];
  const names = new Set<string>();
  for (const entry of value.entries) {
    if (
      !isEditorRecord(entry) ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      entry.name === '.' ||
      entry.name === '..' ||
      /[\uD800-\uDFFF/]/u.test(entry.name) ||
      entry.name.includes('\u0000') ||
      Buffer.byteLength(entry.name) > 1024 ||
      (entry.kind !== 'directory' && entry.kind !== 'file') ||
      names.has(entry.name)
    )
      return null;
    names.add(entry.name);
    entries.push({ name: entry.name, kind: entry.kind });
  }
  if (value.status !== 'ok' && value.status !== 'partial' && entries.length) return null;
  return { status: value.status as ShellPathQueryResult['status'], scanned: value.scanned as number, entries };
};

/**
 * Sends literal path fields as stdin JSON to the validated installed binary, never as Shell arguments.
 * @param client Existing SSH transport. @param binaryPath Validated installed absolute helper path.
 * @returns A bounded cancellable structured-query executor.
 */
export const createRemotePathExecutor =
  (client: Client, binaryPath: string): RemotePathExecutor =>
  async (request, signal) => {
    const command = "'" + binaryPath.replaceAll("'", "'\\''") + "' path-query";
    const output = await executeBoundedSshCommand(client, command, {
      stdin: JSON.stringify(request),
      timeoutMs: 3500,
      maxOutputBytes: 1024 * 1024,
      signal,
    });
    if (signal.aborted) return emptyPathResult('cancelled');
    if (output === null) return emptyPathResult('unavailable');
    try {
      return normalizePathQueryResult(JSON.parse(output)) ?? emptyPathResult('unavailable');
    } catch {
      return emptyPathResult('unavailable');
    }
  };

/**
 * One session's bounded path source. Equal queries coalesce; a different query cancels its predecessor.
 * Cached filenames are actively removed after two seconds and erased immediately when permission is revoked.
 */
export class RemotePathQueryController {
  private active: { key: string; abort: AbortController; result: Promise<ShellPathQueryResult> } | null = null;
  private cache = new Map<string, { result: ShellPathQueryResult; expires: number; timer: NodeJS.Timeout }>();
  /** @param execute Authenticated bounded SSH transport boundary. */
  constructor(private readonly execute: RemotePathExecutor) {}

  /** @returns Nothing; input changes stop the old source without delaying terminal forwarding. */
  cancel(): void {
    this.active?.abort.abort();
    this.active = null;
  }

  /** @returns Nothing; revocation/teardown removes retained filenames and in-flight work. */
  clear(): void {
    this.cancel();
    for (const item of this.cache.values()) clearTimeout(item.timer);
    this.cache.clear();
  }

  /** @param request Literal lookup bound to freshly confirmed original-Shell directory metadata. @returns Bounded source result. */
  query(request: ShellPathQueryRequest): Promise<ShellPathQueryResult> {
    const key = JSON.stringify(request);
    if (this.active?.key === key) return this.active.result.then((result) => structuredClone(result));
    this.cancel();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(structuredClone(cached.result));
    if (cached) {
      clearTimeout(cached.timer);
      this.cache.delete(key);
    }
    const abort = new AbortController();
    const result = Promise.resolve()
      .then(() => (abort.signal.aborted ? emptyPathResult('cancelled') : this.execute({ ...request }, abort.signal)))
      .then((received) => {
        if (abort.signal.aborted) return emptyPathResult('cancelled');
        const normalized = normalizePathQueryResult(received) ?? emptyPathResult('unavailable');
        if (normalized.status === 'ok' || normalized.status === 'partial') {
          if (this.cache.size >= 8) {
            const oldest = this.cache.keys().next().value!;
            clearTimeout(this.cache.get(oldest)!.timer);
            this.cache.delete(oldest);
          }
          const timer = setTimeout(() => this.cache.delete(key), 2000);
          timer.unref();
          this.cache.set(key, { result: structuredClone(normalized), expires: Date.now() + 2000, timer });
        }
        return normalized;
      })
      .catch(() => emptyPathResult(abort.signal.aborted ? 'cancelled' : 'unavailable'))
      .finally(() => {
        if (this.active?.abort === abort) this.active = null;
      });
    this.active = { key, abort, result };
    return result.then((received) => structuredClone(received));
  }
}

/**
 * Uses a snapshot's actual physical CWD/HOME, preserving symlink parent components and whitespace.
 * @param word Decoded literal word with quote-aware tilde intent. @param directory Fresh original-Shell observation.
 * @param options Query preferences with bounded result count.
 * @returns Structured request and literal prefixes for display/insertion, or null without usable metadata.
 */
export const prepareRemotePathQuery = (
  word: Pick<ShellLiteralWord, 'prefix' | 'homeRelative'>,
  directory: ShellDirectoryContext,
  options: Pick<ShellPathQueryRequest, 'directoriesOnly' | 'fuzzyMatch' | 'limit'>,
): { request: ShellPathQueryRequest; displayPrefix: string; insertPrefix: string } | null => {
  const homeRelative = word.homeRelative && (word.prefix === '~' || word.prefix.startsWith('~/'));
  if (!directory.physical || (homeRelative && !directory.home) || !Number.isFinite(options.limit)) return null;
  let partial = word.prefix;
  if (partial === '.' || partial === '..' || (homeRelative && partial === '~')) partial += '/';
  const separator = partial.lastIndexOf('/');
  const displayPrefix = separator < 0 ? '' : partial.slice(0, separator + 1);
  const fragment = partial.slice(separator + 1);
  const insertPrefix = homeRelative ? directory.home + displayPrefix.slice(1) : displayPrefix;
  const lookup = insertPrefix.startsWith('/') ? insertPrefix : directory.physical + '/' + insertPrefix;
  return {
    request: {
      directory: lookup,
      fragment,
      directoriesOnly: options.directoriesOnly,
      fuzzyMatch: options.fuzzyMatch,
      limit: Math.max(1, Math.min(128, Math.trunc(options.limit))),
    },
    displayPrefix,
    insertPrefix,
  };
};
