import type { ShellCompletionCandidate, ShellEditorBuffer, ShellEditorTarget } from '@cosmosh/api-contract';

import { normalizeEditorBuffer } from '../editor-protocol.js';

/** Backend-only half-open replacement range, measured in Unicode codepoints. */
export type ShellCompletionEdit = { start: number; end: number; text: string };
/** Provider output before the owning session assigns an opaque candidate identifier. */
export type ShellCompletionDraft = Omit<ShellCompletionCandidate, 'id'> & { edit: ShellCompletionEdit };
/** Literal word including its original quoting, and decoded text up to the actual cursor. */
export type ShellLiteralWord = { start: number; end: number; value: string; prefix: string; homeRelative: boolean };
/** A deliberately restricted simple command; unsupported syntax has no precise candidates. */
export type ShellCompletionContext = { words: string[]; wordIndex: number; word: ShellLiteralWord };

const RESERVED_COMMANDS = new Set([
  '!',
  '[[',
  ']]',
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'end',
  'esac',
  'fi',
  'for',
  'foreach',
  'function',
  'if',
  'in',
  'repeat',
  'select',
  'switch',
  'then',
  'time',
  'until',
  'while',
  'begin',
  'and',
  'or',
  'not',
]);

/** @param character One codepoint. @returns Whether it separates words in the supported literal grammar. */
const isSeparator = (character: string): boolean => character === ' ' || character === '\t';

/**
 * Recognizes literal simple-command words, never executes or expands Shell syntax.
 * A whole-word range allows replacing an unfinished quote or a token with text after the cursor.
 * Complex syntax and ambiguous escape boundaries defer to the Shell's native completion.
 * @param shell Actual original Shell. @param buffer Validated complete editor observation.
 * @returns Literal completion context, or null for unsupported syntax.
 */
export const parseShellCompletionContext = (
  shell: ShellEditorTarget['shell'],
  buffer: ShellEditorBuffer,
): ShellCompletionContext | null => {
  if (!normalizeEditorBuffer(buffer)) return null;
  const points = Array.from(buffer.text);
  const words: ShellLiteralWord[] = [];
  let index = 0;
  while (index < points.length) {
    if (isSeparator(points[index])) {
      index += 1;
      continue;
    }
    const start = index;
    let quote: "'" | '"' | null = null;
    let value = '';
    let prefix = '';
    let homeRelative = false;
    let quoted = false;
    while (index < points.length) {
      const character = points[index];
      if (!quote && isSeparator(character)) break;
      let decoded = character;
      let width = 1;
      if (character === quote) {
        // RC_QUOTES changes adjacent single quotes into an apostrophe in Zsh.
        if (shell === 'zsh' && quote === "'" && points[index + 1] === "'") return null;
        quote = null;
        decoded = '';
      } else if (!quote && (character === "'" || character === '"')) {
        quote = character;
        quoted = true;
        decoded = '';
      } else if (character === '\\' && (quote !== "'" || shell === 'fish')) {
        const next = points[index + 1];
        if (next === undefined) return null;
        const escaped = quote === "'" ? "\\'" : quote === '"' ? (shell === 'fish' ? '\\"$' : '\\"$`') : null;
        if (escaped === null || escaped.includes(next)) {
          // Fish has encoded escapes such as \xNN and \uNNNN outside quotes.
          if (!quote && shell === 'fish' && /[a-zA-Z0-9]/u.test(next)) return null;
          decoded = next;
          width = 2;
          if (buffer.cursor === index + 1) return null;
        }
      } else if (quote !== "'") {
        if (character === '$' || character === '`' || character === '!') return null;
        if (!quote && ';&|<>(){}[]*?#^%'.includes(character)) return null;
        if (!quote && character === '=' && (words.length === 0 || index === start)) return null;
        if (!quote && character === '~') {
          if (
            index !== start ||
            (points[index + 1] !== '/' && points[index + 1] !== undefined && !isSeparator(points[index + 1]))
          )
            return null;
          homeRelative = true;
        }
      }
      value += decoded;
      if (index + width <= buffer.cursor) prefix += decoded;
      index += width;
    }
    if (quote && !(start <= buffer.cursor && buffer.cursor <= index)) return null;
    if (words.length === 0 && !quoted && RESERVED_COMMANDS.has(value)) return null;
    words.push({ start, end: index, value, prefix, homeRelative });
  }
  const wordIndex = words.findIndex((word) => word.start <= buffer.cursor && buffer.cursor <= word.end);
  if (wordIndex >= 0) return { words: words.map((word) => word.value), wordIndex, word: words[wordIndex] };
  const insertionIndex = words.filter((word) => word.end < buffer.cursor).length;
  const values = words.map((word) => word.value);
  values.splice(insertionIndex, 0, '');
  return {
    words: values,
    wordIndex: insertionIndex,
    word: { start: buffer.cursor, end: buffer.cursor, value: '', prefix: '', homeRelative: false },
  };
};

/**
 * Quotes one literal argument; no substitutions, history expansion or evaluation are permitted.
 * @param shell Actual original Shell. @param value Literal argument, never prequoted Shell code.
 * @returns A complete quoted word, or null for unsupported data.
 */
export const quoteShellLiteral = (shell: ShellEditorTarget['shell'], value: string): string | null => {
  if (!normalizeEditorBuffer({ text: value, cursor: 0 })) return null;
  return (
    "'" +
    (shell === 'fish' ? value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") : value.replaceAll("'", "'\\''")) +
    "'"
  );
};

/**
 * Constructs a literal filename argument without turning a leading hyphen into an option.
 * HOME expansion must already have been resolved using this snapshot's confirmed directory.
 * @param shell Actual original Shell. @param value Literal relative or absolute path.
 * @returns Quoted path, or null for unsupported data.
 */
export const quoteShellPath = (shell: ShellEditorTarget['shell'], value: string): string | null =>
  quoteShellLiteral(shell, value.startsWith('-') ? './' + value : value);

/**
 * Preserves all text outside a snapshot-bound word/history range, including the unrelated suffix.
 * @param buffer Original complete input. @param edit Backend-owned codepoint edit containing the cursor.
 * @returns Complete replacement and cursor, or null for invalid/oversized data.
 */
export const buildShellCompletionReplacement = (
  buffer: ShellEditorBuffer,
  edit: ShellCompletionEdit,
): ShellEditorBuffer | null => {
  if (!normalizeEditorBuffer(buffer)) return null;
  const points = Array.from(buffer.text);
  if (
    !Number.isSafeInteger(edit.start) ||
    !Number.isSafeInteger(edit.end) ||
    edit.start < 0 ||
    edit.start > buffer.cursor ||
    edit.end < buffer.cursor ||
    edit.end > points.length
  )
    return null;
  return normalizeEditorBuffer({
    text: points.slice(0, edit.start).join('') + edit.text + points.slice(edit.end).join(''),
    cursor: edit.start + Array.from(edit.text).length,
  });
};
