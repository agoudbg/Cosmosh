import type { ShellEditorSnapshot, ShellNativeCompletionResult } from '@cosmosh/api-contract';

import { isEditorRecord, normalizeEditorBuffer } from '../editor-protocol.js';
import {
  buildShellCompletionReplacement,
  parseShellCompletionContext,
  quoteShellLiteral,
  type ShellCompletionDraft,
} from './snapshot-edits.js';

/** @param value Untrusted field. @param limit Byte limit. @returns Whether text is bounded and control-free. */
const isCompletionText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  !value.includes('\t') &&
  normalizeEditorBuffer({ text: value, cursor: 0 }) !== null &&
  Buffer.byteLength(value, 'utf8') <= limit;

/**
 * Normalizes remote advisory values at the SSH boundary; no environment or unsolicited fields cross it.
 * @param value Untrusted worker output. @returns A bounded copy, or null on malformed framing.
 */
export const normalizeNativeCompletionResult = (value: unknown): ShellNativeCompletionResult | null => {
  if (!isEditorRecord(value) || !Array.isArray(value.entries) || value.entries.length > 128) return null;
  if (value.status === 'timeout' || value.status === 'unavailable')
    return value.entries.length === 0 ? { status: value.status, entries: [] } : null;
  if (value.status !== 'ok' && value.status !== 'partial') return null;
  const entries: ShellNativeCompletionResult['entries'] = [];
  let total = 0;
  for (const entry of value.entries) {
    if (
      !isEditorRecord(entry) ||
      !isCompletionText(entry.token, 8192) ||
      entry.token.length === 0 ||
      !isCompletionText(entry.value, 8192) ||
      entry.value.length === 0 ||
      (entry.detail !== null && !isCompletionText(entry.detail, 1024))
    )
      return null;
    total += Buffer.byteLength(entry.token + entry.value + (entry.detail ?? ''), 'utf8');
    if (total > 64 * 1024) return null;
    entries.push({ token: entry.token, value: entry.value, detail: entry.detail });
  }
  return { status: value.status, entries };
};

/**
 * Restricts Fish's cursor-less query API to an actual end-of-line simple literal command.
 * @param snapshot Original reader observation. @returns Whether native query semantics are supported.
 */
export const canQueryNativeCompletion = (snapshot: ShellEditorSnapshot): boolean =>
  Boolean(
    snapshot.buffer &&
    snapshot.directory?.physical &&
    snapshot.buffer.cursor === Array.from(snapshot.buffer.text).length &&
    parseShellCompletionContext('fish', snapshot.buffer),
  );

/**
 * Converts Fish's whole-token results to literal edits; string unescape alone is not a syntax validator.
 * LF descriptions may look like extra rows in Fish's public format, so this source remains advisory.
 * @param snapshot Owning full observation. @param result Validated independent query result.
 * @returns Supported edits with no inferred trailing space or executable Shell fragments.
 */
export const buildNativeCompletionDrafts = (
  snapshot: ShellEditorSnapshot,
  result: ShellNativeCompletionResult,
): ShellCompletionDraft[] => {
  if (
    !canQueryNativeCompletion(snapshot) ||
    !snapshot.buffer ||
    !snapshot.directory ||
    (result.status !== 'ok' && result.status !== 'partial')
  )
    return [];
  const context = parseShellCompletionContext('fish', snapshot.buffer)!;
  const drafts: ShellCompletionDraft[] = [];
  for (const entry of result.entries) {
    const probe = 'x ' + entry.token;
    const parsed = parseShellCompletionContext('fish', { text: probe, cursor: Array.from(probe).length });
    if (!parsed || parsed.words.length !== 2 || parsed.wordIndex !== 1 || parsed.word.value !== entry.value) continue;
    let value = entry.value;
    if (parsed.word.homeRelative) {
      const home = snapshot.directory.home;
      if (!home || (value !== '~' && !value.startsWith('~/'))) continue;
      value = home.replace(/\/$/u, '') + (value === '~' ? '/' : value.slice(1));
    }
    const text = quoteShellLiteral('fish', value);
    if (text === null) continue;
    const edit = { start: context.word.start, end: context.word.end, text };
    const replacement = buildShellCompletionReplacement(snapshot.buffer, edit);
    if (!replacement || replacement.text === snapshot.buffer.text) continue;
    drafts.push({ label: value, detail: entry.detail, source: 'fish', kind: 'argument', edit });
  }
  return drafts;
};
