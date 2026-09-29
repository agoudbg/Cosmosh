import { randomUUID } from 'node:crypto';

import type { TerminalCredentialFillOffer } from '@cosmosh/api-contract';

const OFFER_LIFETIME_MS = 45_000;
const OUTPUT_TAIL_LIMIT = 1_024;
const PASSWORD_PROMPT = /(?:^|\s)password(?: for [^:]+)?:\s*$/iu;
// eslint-disable-next-line no-control-regex -- These complete controls cannot alter visible prompt text.
const NONVISUAL_CONTROL = /^\x1b\[(?:[\d;:]*m|\?2004[hl])$/u;
const CONTROL_PREFIX_LIMIT = 64;

/** Bounded visible PTY output and an opaque offer; saved credentials and raw input are never assigned here. */
export type CredentialFillState = {
  outputTail: string;
  offer: TerminalCredentialFillOffer | null;
  /** Incomplete control framing only; string-control payloads are never retained. */
  pendingControl?: string;
};

/**
 * Creates empty credential-action state, also used to invalidate an offer before any input.
 *
 * @param previous Same-stream state whose unfinished output framing must survive invalidation.
 * Omit only when starting or disposing an output stream.
 * @returns State without visible prompt text or a reusable token, retaining only unfinished framing.
 */
export const createCredentialFillState = (previous?: CredentialFillState): CredentialFillState => ({
  outputTail: '',
  offer: null,
  ...(previous?.pendingControl ? { pendingControl: previous.pendingControl } : {}),
});

/**
 * Fences incomplete VT controls across transport chunks without reconstructing a screen.
 * Only SGR and bracketed-paste mode switches are nonvisual; other controls invalidate
 * the whole observation. OSC/DCS/SOS/PM/APC payloads are discarded, including newlines.
 * @param pending Previous bounded control prefix, never its payload.
 * @param output New terminal bytes decoded as text.
 * @returns Plain output and unfinished framing; unsafe observations cannot issue an offer.
 */
const inspectCredentialOutput = (pending: string, output: string) => {
  let visible = '';
  let unsafe = false;
  for (const char of output) {
    const code = char.codePointAt(0)!;
    if (char === '\x1b' || code === 0x9b || code === 0x9d || [0x90, 0x98, 0x9e, 0x9f].includes(code)) {
      if (pending || char !== '\x1b') unsafe = true;
      pending = char === '\x1b' ? char : code === 0x9b ? '\x1b[' : code === 0x9d ? '\x1b]' : '\x1bP';
      continue;
    }
    if (code === 0x18 || code === 0x1a || code === 0x9c) {
      unsafe = true;
      pending = '';
      continue;
    }
    if (pending === '\x1b]' || pending === '\x1bP') {
      unsafe = true;
      if (pending === '\x1b]' && char === '\x07') pending = '';
      continue;
    }
    if (pending) {
      if (pending === '\x1b' && ['[', ']', 'P', 'X', '^', '_'].includes(char)) {
        pending = char === '[' || char === ']' ? pending + char : '\x1bP';
        if (char !== '[') unsafe = true;
        continue;
      }
      const csi = pending.startsWith('\x1b[');
      if (code >= (csi ? 0x40 : 0x30) && code <= 0x7e) {
        if (!NONVISUAL_CONTROL.test(pending + char)) unsafe = true;
        pending = '';
      } else if (code >= 0x20 && code <= 0x3f) {
        // Overflow retains only a rejected framing marker, so later payload cannot become visible text.
        pending = pending.length < CONTROL_PREFIX_LIMIT ? pending + char : csi ? '\x1b[!' : '\x1b!';
      } else {
        unsafe = true;
      }
      continue;
    }
    if (/\p{Cc}/u.test(char) && char !== '\r' && char !== '\n') unsafe = true;
    else visible += char;
  }
  return { visible, pending, unsafe: unsafe || pending.length > 0 };
};

/**
 * Observes visible password-prompt text without claiming which program owns the prompt.
 * A click always names the saved server login password; key passphrases are not eligible.
 *
 * @param state Previous bounded output and offer.
 * @param output New visible PTY output.
 * @param nowMs Current wall-clock timestamp.
 * @returns Updated state. Nonvisual controls/whitespace cannot extend an existing offer's lifetime.
 */
export const observeCredentialFillOutput = (
  state: CredentialFillState,
  output: string,
  nowMs: number,
): CredentialFillState => {
  const inspected = inspectCredentialOutput(state.pendingControl ?? '', output);
  // Cursor/erase controls and fragmented escapes cannot prove the old text remains visible.
  // Require fresh visible prompt output after these transitions instead of interpreting a screen.
  if (inspected.unsafe) {
    return {
      ...createCredentialFillState(),
      ...(inspected.pending ? { pendingControl: inspected.pending } : {}),
    };
  }
  const outputTail = `${state.outputTail}${inspected.visible}`.replace(/\r/gu, '\n').slice(-OUTPUT_TAIL_LIMIT);
  const lastLine = outputTail.split('\n').at(-1) ?? '';
  const retainedOffer = /^ *$/u.test(inspected.visible) ? state.offer : null;
  const offer = PASSWORD_PROMPT.test(lastLine)
    ? (retainedOffer ?? { token: randomUUID(), expiresAt: nowMs + OFFER_LIFETIME_MS })
    : null;
  return { outputTail, offer };
};

/**
 * Checks whether a login password can be written literally without sending terminal controls.
 *
 * @param password Saved login password, never a private-key passphrase.
 * @returns True for a nonempty bounded value containing no control characters.
 */
export const isFillableLoginPassword = (password: string | null): password is string =>
  typeof password === 'string' &&
  password.length > 0 &&
  Buffer.byteLength(password, 'utf8') <= 8_192 &&
  !/\p{Cc}/u.test(password);
