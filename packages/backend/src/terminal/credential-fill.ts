import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

import type { TerminalCredentialFillOffer } from '@cosmosh/api-contract';

const OFFER_LIFETIME_MS = 45_000;
const OUTPUT_TAIL_LIMIT = 1_024;
const PASSWORD_PROMPT = /(?:^|\s)password(?: for [^:]+)?:\s*$/iu;
// eslint-disable-next-line no-control-regex -- Only complete SGR styling may retain a visible prompt.
const SGR_STYLING = /\x1b\[[\d;:]*m/gu;

/** Bounded visible PTY output and an opaque offer; saved credentials and raw input are never assigned here. */
export type CredentialFillState = {
  outputTail: string;
  offer: TerminalCredentialFillOffer | null;
};

/**
 * Creates empty credential-action state, also used to invalidate an offer before any input.
 *
 * @returns State without a reusable prompt token.
 */
export const createCredentialFillState = (): CredentialFillState => ({ outputTail: '', offer: null });

/**
 * Observes visible password-prompt text without claiming which program owns the prompt.
 * A click always names the saved server login password; key passphrases are not eligible.
 *
 * @param state Previous bounded output and offer.
 * @param output New visible PTY output.
 * @param nowMs Current wall-clock timestamp.
 * @returns Updated state. Repeated ANSI/whitespace output cannot extend an existing offer's lifetime.
 */
export const observeCredentialFillOutput = (
  state: CredentialFillState,
  output: string,
  nowMs: number,
): CredentialFillState => {
  const visibleOutput = stripVTControlCharacters(output);
  const withoutStyling = output.replace(SGR_STYLING, '');
  // Cursor/erase controls and fragmented escapes cannot prove the old text remains visible.
  // Require fresh visible prompt output after these transitions instead of interpreting a screen.
  if (visibleOutput !== withoutStyling || /\p{Cc}/u.test(withoutStyling.replaceAll('\r', '').replaceAll('\n', ''))) {
    return createCredentialFillState();
  }
  const outputTail = `${state.outputTail}${visibleOutput}`.replace(/\r/gu, '\n').slice(-OUTPUT_TAIL_LIMIT);
  const lastLine = outputTail.split('\n').at(-1) ?? '';
  const retainedOffer = /^ *$/u.test(withoutStyling) ? state.offer : null;
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
