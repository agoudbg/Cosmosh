import type { ShellEditorBuffer, ShellEditorTarget } from '@cosmosh/api-contract';

import { normalizeEditorBuffer } from '../editor-protocol.js';
import { resolveCommandMetadata } from './engine.js';
import { scoreCompletionMatch } from './matching.js';
import {
  buildShellCompletionReplacement,
  parseShellCompletionContext,
  quoteShellLiteral,
  type ShellCompletionDraft,
} from './snapshot-edits.js';

/** Maximum history retained from a single current-Shell observation; no older local fallback is merged. */
export const SHELL_HISTORY_LIMIT = 200;
const HISTORY_BYTES = 64 * 1024;

/**
 * Keeps the Shell's newest-first order, exact text and first occurrence of each complete entry.
 * This accepts only a Shell-owned source; raw input and mixed history files must never be supplied.
 * @param entries Native newest-first complete entries. @returns Bounded exact command text, including multiline history.
 */
export const normalizeShellHistory = (entries: readonly string[]): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const text of entries.slice(0, SHELL_HISTORY_LIMIT)) {
    const size = Buffer.byteLength(text);
    if (!text.trim() || text.includes('\0') || /[\uD800-\uDFFF]/u.test(text) || size > 8192 || seen.has(text)) continue;
    if (bytes + size > HISTORY_BYTES) break;
    bytes += size;
    seen.add(text);
    result.push(text);
  }
  return result;
};

/**
 * Produces immediate history and static metadata edits from actual input. History replaces a whole line only
 * at its end; middle-of-line editing retains all surrounding arguments through word-scoped metadata edits.
 * @param shell Original Shell. @param buffer Actual complete editor input. @param history Native newest-first entries.
 * @param options Independently enabled sources and matching preference. @returns Source-labelled private drafts.
 */
export const resolveSnapshotSuggestions = (
  shell: ShellEditorTarget['shell'],
  buffer: ShellEditorBuffer,
  history: readonly string[],
  options: { history: boolean; metadata: boolean; fuzzyMatch: boolean },
): ShellCompletionDraft[] => {
  if (!normalizeEditorBuffer(buffer)) return [];
  const drafts: ShellCompletionDraft[] = [];
  const length = Array.from(buffer.text).length;
  if (options.history && buffer.cursor === length) {
    for (const [index, text] of normalizeShellHistory(history).entries()) {
      if (!normalizeEditorBuffer({ text, cursor: Array.from(text).length })) continue;
      const score = scoreCompletionMatch(buffer.text, text, options.fuzzyMatch);
      if (!score || text === buffer.text) continue;
      // Within the same match class, native recency outranks command length.
      const matchClassScore = score >= 900 ? 1000 : score >= 400 ? 600 : 120;
      drafts.push({
        label: text,
        detail: null,
        detailI18nKey: 'completion.labels.history',
        source: 'history',
        kind: 'history',
        score: matchClassScore + SHELL_HISTORY_LIMIT - index,
        edit: { start: 0, end: length, text },
      });
    }
  }
  const context = options.metadata ? parseShellCompletionContext(shell, buffer) : null;
  if (context) {
    for (const item of resolveCommandMetadata(
      context.words,
      context.wordIndex,
      context.word.prefix,
      options.fuzzyMatch,
    )) {
      let text: string | null;
      if (item.insertion === 'literal') text = quoteShellLiteral(shell, item.insertText);
      else {
        // Only explicitly multiword snippets are parsed. Literal values such as "data science" remain one argument.
        const literalInput = 'metadata ' + item.insertText;
        const parsed = parseShellCompletionContext(shell, {
          text: literalInput,
          cursor: Array.from(literalInput).length,
        });
        if (!parsed) continue;
        const words = parsed.words.slice(1).map((word) => {
          // Keep conventional flags readable, but quote reserved words and every character that can expand.
          const bare =
            /^[A-Za-z0-9_./+-]+$/u.test(word) &&
            parseShellCompletionContext(shell, { text: word, cursor: word.length });
          return bare ? word : quoteShellLiteral(shell, word);
        });
        if (words.some((word) => word === null)) continue;
        if (parsed.word.value === '' && /[\t ]$/u.test(item.insertText)) words[words.length - 1] = '';
        text = words.join(' ');
      }
      if (text === null) continue;
      drafts.push({
        label: item.label,
        detail: null,
        ...(item.detailI18nKey ? { detailI18nKey: item.detailI18nKey } : {}),
        source: 'inshellisense',
        kind: item.kind,
        score: item.score,
        edit: { start: context.word.start, end: context.word.end, text },
      });
    }
  }
  return drafts;
};

/**
 * Ranks all currently available sources and deduplicates by the exact resulting input and cursor.
 * Identical display labels alone do not prove that two edits do the same thing.
 * Qualified Fish results know the current command's argument semantics, so their native order precedes
 * generic history, metadata and filesystem guesses. Other sources keep their existing match/recency scoring.
 * @param buffer Owning snapshot. @param drafts Available source drafts. @param limit Bounded menu size.
 * @returns Deterministic applicable edits; invalid or unchanged replacements are excluded.
 */
export const rankSnapshotSuggestions = (
  buffer: ShellEditorBuffer,
  drafts: readonly ShellCompletionDraft[],
  limit = 16,
): ShellCompletionDraft[] => {
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(128, Math.floor(limit))) : 16;
  const sourceOrder = { runtime: 0, fish: 1, history: 2, inshellisense: 3 };
  const sorted = [...drafts].sort((left, right) => {
    const nativePriority = Number(left.source !== 'fish') - Number(right.source !== 'fish');
    if (nativePriority !== 0) return nativePriority;
    // Stable sort preserves the Shell's relevance ordering, including ties and exact-edit duplicates.
    if (left.source === 'fish' && right.source === 'fish') return 0;
    return (
      (right.score ?? 0) - (left.score ?? 0) ||
      sourceOrder[left.source] - sourceOrder[right.source] ||
      left.label.localeCompare(right.label)
    );
  });
  const seen = new Set<string>();
  const result: ShellCompletionDraft[] = [];
  for (const draft of sorted) {
    const replacement = buildShellCompletionReplacement(buffer, draft.edit);
    if (!replacement || (replacement.text === buffer.text && replacement.cursor === buffer.cursor)) continue;
    const key = JSON.stringify(replacement);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(draft);
    if (result.length === boundedLimit) break;
  }
  return result;
};
