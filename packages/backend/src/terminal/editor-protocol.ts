import type { ShellEditorBuffer, ShellEditorRequest, ShellEditorSnapshot } from '@cosmosh/api-contract';

/** Raw UTF-8 input bound shared with the Go helper. */
export const EDITOR_INPUT_MAX_BYTES = 8192;
/** Encoded envelope bound includes two buffers and literal directory metadata. */
export const EDITOR_MESSAGE_MAX_BYTES = 256 * 1024;

/**
 * Mirrors the Bash adapter's closed native-key profile. Tab, search, macros, mode changes and
 * unknown escape sequences can run arbitrary Shell code, so they invalidate the current editor.
 * @param input Incoming PTY data, inspected without retaining it.
 * @returns Whether a confirmed Bash epoch remains eligible for automatic editor requests.
 */
export const isSupportedBashEditorInput = (input: string): boolean => {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 27 && ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'].includes(input.slice(index, index + 3))) {
      index += 2;
      continue;
    }
    if (
      (code < 32 || (code >= 127 && code <= 159)) &&
      ![1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 16, 21, 23, 127].includes(code)
    )
      return false;
  }
  return true;
};

/** @param value Untrusted JSON value. @returns A plain record only. */
export const isEditorRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Validates the UTF-16 boundary used by JavaScript and rejects multiline/control input.
 * @param value Untrusted buffer. @returns A normalized copy, or null without echoing rejected input.
 */
export const normalizeEditorBuffer = (value: unknown): ShellEditorBuffer | null => {
  if (
    !isEditorRecord(value) ||
    typeof value.text !== 'string' ||
    /[\uD800-\uDFFF]/u.test(value.text) ||
    Buffer.byteLength(value.text, 'utf8') > EDITOR_INPUT_MAX_BYTES ||
    Array.from(value.text).some((character) => {
      const code = character.codePointAt(0)!;
      return (code < 32 && code !== 9) || (code >= 127 && code <= 159);
    }) ||
    typeof value.cursor !== 'number' ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    value.cursor > value.text.length ||
    (value.cursor > 0 &&
      value.cursor < value.text.length &&
      /[\uD800-\uDBFF]/u.test(value.text[value.cursor - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(value.text[value.cursor]!))
  )
    return null;
  return { text: value.text, cursor: value.cursor };
};

/** @param value Untrusted exact path. @returns Whether it is a bounded absolute Linux path. */
const validPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.includes('\u0000') &&
  !/[\uD800-\uDFFF]/u.test(value) &&
  Buffer.byteLength(value, 'utf8') <= 4096;

/**
 * Enforces the request's privacy boundary on each helper observation.
 * @param value Untrusted response snapshot. @param request Requested fields and prompt generation.
 * @returns A normalized snapshot or null, never an error containing terminal text.
 */
export const normalizeEditorSnapshot = (value: unknown, request: ShellEditorRequest): ShellEditorSnapshot | null => {
  if (
    !isEditorRecord(value) ||
    value.promptGeneration !== request.promptGeneration ||
    (value.editorMode !== 'emacs' && value.editorMode !== 'vi-insert')
  )
    return null;
  const result: ShellEditorSnapshot = { promptGeneration: request.promptGeneration, editorMode: value.editorMode };
  if (request.operation === 'context') {
    if ('buffer' in value) return null;
  } else {
    const buffer = normalizeEditorBuffer(value.buffer);
    if (!buffer) return null;
    result.buffer = buffer;
  }
  if (request.includeDirectory) {
    const directory = value.directory;
    if (
      !isEditorRecord(directory) ||
      !validPath(directory.logical) ||
      (directory.physical !== null && !validPath(directory.physical)) ||
      (directory.home !== null && !validPath(directory.home))
    )
      return null;
    result.directory = { logical: directory.logical, physical: directory.physical, home: directory.home };
  } else if ('directory' in value) return null;
  return result;
};
