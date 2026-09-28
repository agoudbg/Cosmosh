import {
  REMOTE_SHELL_CAPABILITIES,
  REMOTE_SHELL_EVENT_NAMES,
  REMOTE_SHELL_NAMES,
  REMOTE_SHELL_PROTOCOL_VERSION,
  type RemoteShellCapability,
  type RemoteShellEventMessage,
  type RemoteShellEventName,
  type RemoteShellName,
} from '@cosmosh/api-contract';

export type { RemoteShellEventMessage } from '@cosmosh/api-contract';

/** Encoded OSC envelope budget, including Base64 expansion of bounded v3 fields. */
export const REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES = 48 * 1024;
const REMOTE_SHELL_EVENT_JSON_MAX_BYTES = 32 * 1024;

const ESCAPE = '\u001b';
const BELL = '\u0007';
const STRING_TERMINATOR = `${ESCAPE}\\`;
const COSMOSH_OSC_PREFIX = `${ESCAPE}]777;cosmosh;`;

const REMOTE_SHELL_EVENT_SET = new Set<RemoteShellEventName>(REMOTE_SHELL_EVENT_NAMES);
const REMOTE_SHELL_NAME_SET = new Set<RemoteShellName>(REMOTE_SHELL_NAMES);
const REMOTE_SHELL_CAPABILITY_SET = new Set<RemoteShellCapability>(REMOTE_SHELL_CAPABILITIES);
const REMOTE_SHELL_HELPER_VERSION_PATTERN = /^[A-Za-z0-9._+-]+$/;
const REMOTE_SHELL_CAPABILITY_MAX_COUNT = 32;
const REMOTE_SHELL_COMMAND_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const REMOTE_SHELL_CWD_MAX_BYTES = 4 * 1024;
const REMOTE_SHELL_COMMAND_MAX_BYTES = 255;
const REMOTE_SHELL_LINE_LENGTH_MAX = 1024 * 1024;

/**
 * One ordered item recovered from the SSH PTY stream.
 *
 * Visible output and trusted helper events must remain interleaved so renderer
 * xterm geometry reflects every byte that preceded a lifecycle event.
 */
export type RemoteShellEventStreamFrame =
  { type: 'output'; data: string } | { type: 'event'; event: RemoteShellEventMessage };

/** Parsed representation of one completed OSC sequence. */
type ParsedOscSequence = {
  output: string;
  event: RemoteShellEventMessage | null;
};

/**
 * Streams terminal output through the Cosmosh OSC 777 parser.
 *
 * SSH output arrives in arbitrary chunks, so OSC payloads may be split across
 * reads. This parser keeps only the active OSC sequence in memory and strips
 * recognized Cosmosh events before they reach xterm.
 */
export class RemoteShellEventOscParser {
  private pendingEscape = false;

  private pendingOscPrefix: string | null = null;

  private pendingCosmoshOsc: string | null = null;

  private pendingCosmoshPayloadBytes = 0;

  private discardingOversizedCosmoshOsc = false;

  private discardSawEscape = false;

  /**
   * Parses one SSH output chunk.
   *
   * @param chunk Raw UTF-8 terminal output chunk.
   * @returns Ordered visible-output and normalized-event frames.
   */
  public parse(chunk: string): RemoteShellEventStreamFrame[] {
    let output = '';
    const frames: RemoteShellEventStreamFrame[] = [];

    /**
     * Flushes visible bytes before appending the event that followed them in
     * the same PTY stream chunk.
     *
     * @param parsed Completed OSC parse result.
     * @returns Nothing.
     */
    const appendParsedOsc = (parsed: ParsedOscSequence): void => {
      output += parsed.output;
      if (!parsed.event) {
        return;
      }

      if (output) {
        frames.push({ type: 'output', data: output });
        output = '';
      }
      frames.push({ type: 'event', event: parsed.event });
    };

    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index] ?? '';

      if (this.discardingOversizedCosmoshOsc) {
        this.consumeDiscardedOscChar(char);
        continue;
      }

      if (this.pendingCosmoshOsc !== null) {
        const completedSequence = this.appendCosmoshOscChar(char);
        if (completedSequence === null) {
          continue;
        }

        appendParsedOsc(this.parseCompletedOsc(completedSequence));
        continue;
      }

      if (this.pendingOscPrefix !== null) {
        const prefixResult = this.appendOscPrefixChar(char);
        output += prefixResult.output;
        if (prefixResult.completedSequence) {
          appendParsedOsc(this.parseCompletedOsc(prefixResult.completedSequence));
        }
        continue;
      }

      if (this.pendingEscape) {
        this.pendingEscape = false;
        if (char === ']') {
          this.pendingOscPrefix = `${ESCAPE}]`;
          continue;
        }

        output += `${ESCAPE}${char}`;
        continue;
      }

      if (char === ESCAPE) {
        this.pendingEscape = true;
        continue;
      }

      output += char;
    }

    if (output) {
      frames.push({ type: 'output', data: output });
    }
    return frames;
  }

  /**
   * Flushes any incomplete sequence as visible output.
   *
   * This is intended for session teardown only; normal chunk parsing should
   * keep incomplete OSC data pending because the next SSH chunk may finish it.
   *
   * @returns Buffered visible output.
   */
  public flush(): string {
    let output = '';

    if (this.pendingEscape) {
      output += ESCAPE;
      this.pendingEscape = false;
    }

    if (this.pendingOscPrefix !== null) {
      output += this.pendingOscPrefix;
      this.pendingOscPrefix = null;
    }

    if (this.pendingCosmoshOsc !== null) {
      output += this.pendingCosmoshOsc;
      this.pendingCosmoshOsc = null;
      this.pendingCosmoshPayloadBytes = 0;
    }

    this.discardingOversizedCosmoshOsc = false;
    this.discardSawEscape = false;

    return output;
  }

  /**
   * Appends one character while collecting an OSC sequence.
   *
   * @param char Next character in the SSH output stream.
   * @returns Completed sequence, or null while waiting for a terminator.
   */
  private appendOscPrefixChar(char: string): { output: string; completedSequence: string | null } {
    if (this.pendingOscPrefix === null) {
      return { output: '', completedSequence: null };
    }

    this.pendingOscPrefix += char;
    const candidate = this.pendingOscPrefix;

    if (candidate.endsWith(BELL) || candidate.endsWith(STRING_TERMINATOR)) {
      this.pendingOscPrefix = null;
      return { output: '', completedSequence: candidate };
    }

    if (candidate === COSMOSH_OSC_PREFIX) {
      this.pendingOscPrefix = null;
      this.pendingCosmoshOsc = candidate;
      this.pendingCosmoshPayloadBytes = 0;
      return { output: '', completedSequence: null };
    }

    if (COSMOSH_OSC_PREFIX.startsWith(candidate)) {
      return { output: '', completedSequence: null };
    }

    this.pendingOscPrefix = null;
    return { output: candidate, completedSequence: null };
  }

  /**
   * Appends one character to a confirmed Cosmosh OSC sequence.
   *
   * @param char Next character from the SSH output stream.
   * @returns Completed sequence, or null while collecting/discarding it.
   */
  private appendCosmoshOscChar(char: string): string | null {
    if (this.pendingCosmoshOsc === null) {
      return null;
    }

    this.pendingCosmoshOsc += char;
    if (this.pendingCosmoshOsc.endsWith(BELL) || this.pendingCosmoshOsc.endsWith(STRING_TERMINATOR)) {
      const completed = this.pendingCosmoshOsc;
      this.pendingCosmoshOsc = null;
      this.pendingCosmoshPayloadBytes = 0;
      return completed;
    }

    this.pendingCosmoshPayloadBytes += Buffer.byteLength(char, 'utf8');
    if (this.pendingCosmoshPayloadBytes > REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES) {
      this.pendingCosmoshOsc = null;
      this.pendingCosmoshPayloadBytes = 0;
      this.discardingOversizedCosmoshOsc = true;
      // The byte that crossed the cap may be the ESC of an ST terminator;
      // forgetting it would blackhole output until an unrelated BEL arrives.
      this.discardSawEscape = char === ESCAPE;
    }

    return null;
  }

  /**
   * Consumes characters until an oversized Cosmosh OSC reaches its terminator.
   *
   * @param char Next character from the stream.
   * @returns Nothing.
   */
  private consumeDiscardedOscChar(char: string): void {
    if (this.discardSawEscape) {
      // A run of ESC bytes keeps the terminator candidate alive: only the
      // final ESC can pair with the backslash that ends the sequence.
      this.discardSawEscape = char === ESCAPE;
      if (char === '\\') {
        this.discardingOversizedCosmoshOsc = false;
      }
      return;
    }

    if (char === BELL) {
      this.discardingOversizedCosmoshOsc = false;
      return;
    }

    if (char === ESCAPE) {
      this.discardSawEscape = true;
    }
  }

  /**
   * Parses or preserves one completed OSC sequence.
   *
   * @param sequence Full OSC bytes including ESC prefix and terminator.
   * @returns Visible output plus any decoded Cosmosh events.
   */
  private parseCompletedOsc(sequence: string): ParsedOscSequence {
    if (!sequence.startsWith(COSMOSH_OSC_PREFIX)) {
      return { output: sequence, event: null };
    }

    const payload = sequence.slice(COSMOSH_OSC_PREFIX.length, readSequencePayloadEnd(sequence));
    if (Buffer.byteLength(payload, 'utf8') > REMOTE_SHELL_EVENT_OSC_PAYLOAD_MAX_BYTES) {
      return { output: '', event: null };
    }

    return {
      output: '',
      event: parseRemoteShellEventPayload(payload),
    };
  }
}

/**
 * Parses a base64-encoded remote shell event payload.
 *
 * @param payload Base64 JSON payload from the OSC sequence.
 * @returns Normalized WebSocket message, or null when invalid.
 */
export const parseRemoteShellEventPayload = (payload: string): RemoteShellEventMessage | null => {
  try {
    const decoded = decodeBoundedBase64Utf8(payload, REMOTE_SHELL_EVENT_JSON_MAX_BYTES);
    if (decoded === null) {
      return null;
    }

    const parsed = JSON.parse(decoded) as unknown;
    return normalizeRemoteShellEvent(parsed);
  } catch {
    return null;
  }
};

/**
 * Converts unknown JSON into the trusted remote shell event contract.
 *
 * @param value Parsed JSON value.
 * @returns Normalized remote shell event message, or null when invalid.
 */
export const normalizeRemoteShellEvent = (value: unknown): RemoteShellEventMessage | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const event = value.event;
  const shell = value.shell;
  const helperVersion = value.helperVersion;
  const protocolVersion = value.protocolVersion;
  const timestamp = value.timestamp;

  if (typeof event !== 'string' || !REMOTE_SHELL_EVENT_SET.has(event as RemoteShellEventName)) {
    return null;
  }

  if (typeof shell !== 'string' || !REMOTE_SHELL_NAME_SET.has(shell as RemoteShellName)) {
    return null;
  }

  if (
    typeof helperVersion !== 'string' ||
    !REMOTE_SHELL_HELPER_VERSION_PATTERN.test(helperVersion) ||
    typeof protocolVersion !== 'number' ||
    protocolVersion !== REMOTE_SHELL_PROTOCOL_VERSION
  ) {
    return null;
  }

  const capabilities = normalizeCapabilities(value.capabilities);
  const shellInstanceId = normalizeCommandId(value.shellInstanceId);
  if (!capabilities || !shellInstanceId) {
    return null;
  }

  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    return null;
  }

  const base = {
    type: 'remote-shell-event',
    shell: shell as RemoteShellName,
    helperVersion,
    protocolVersion,
    capabilities,
    shellInstanceId,
    timestamp,
  } as const;
  const eventName = event as RemoteShellEventName;

  if (eventName === 'integration-ready') {
    return { ...base, event: eventName };
  }

  if (!capabilities.includes(eventName)) {
    return null;
  }

  if (eventName === 'prompt-ready') {
    const promptGeneration = normalizeBoundedInteger(value.promptGeneration, 0, Number.MAX_SAFE_INTEGER);
    if (capabilities.includes('line-state') && promptGeneration === null) {
      return null;
    }

    return promptGeneration === null ? { ...base, event: eventName } : { ...base, event: eventName, promptGeneration };
  }

  if (eventName === 'cwd-invalidated') {
    const promptGeneration = normalizeBoundedInteger(value.promptGeneration, 1, Number.MAX_SAFE_INTEGER);
    return promptGeneration === null ? null : { ...base, event: eventName, promptGeneration };
  }

  if (eventName === 'editor-state') {
    const promptGeneration = normalizeBoundedInteger(value.promptGeneration, 1, Number.MAX_SAFE_INTEGER);
    const pid = normalizeBoundedInteger(value.pid, 2, 2 ** 31 - 1);
    const rawNotification = value.notification;
    const notification =
      rawNotification &&
      typeof rawNotification === 'object' &&
      'fd' in rawNotification &&
      'inode' in rawNotification &&
      normalizeBoundedInteger(rawNotification.fd, 3, 1048575) !== null &&
      typeof rawNotification.inode === 'string' &&
      /^[1-9][0-9]{0,19}$/u.test(rawNotification.inode)
        ? { fd: rawNotification.fd as number, inode: rawNotification.inode }
        : null;
    if (
      promptGeneration === null ||
      pid === null ||
      typeof value.startTime !== 'string' ||
      (value.startTime !== '' && !/^[1-9][0-9]{0,19}$/u.test(value.startTime)) ||
      typeof value.available !== 'boolean' ||
      typeof value.triggerNonce !== 'string' ||
      (value.triggerNonce !== '' &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.triggerNonce)) ||
      (value.available && (value.triggerNonce === '' || value.startTime === '')) ||
      (rawNotification !== undefined && (shell !== 'zsh' || notification === null)) ||
      (shell === 'zsh' && value.available && notification === null)
    )
      return null;
    return {
      ...base,
      event: eventName,
      promptGeneration,
      pid,
      startTime: value.startTime,
      available: value.available,
      triggerNonce: value.triggerNonce,
      ...(notification ? { notification } : {}),
    };
  }

  if (eventName === 'cwd') {
    const cwd = decodeBoundedBase64Utf8(value.cwdBase64, REMOTE_SHELL_CWD_MAX_BYTES);
    const physicalOutput =
      value.physicalCwdOutputBase64 === ''
        ? null
        : decodeBoundedBase64Utf8(value.physicalCwdOutputBase64, REMOTE_SHELL_CWD_MAX_BYTES + 1);
    const physicalCwd = physicalOutput?.endsWith('\n') ? physicalOutput.slice(0, -1) : null;
    const homeDirectory =
      value.homeBase64 === '' ? null : decodeBoundedBase64Utf8(value.homeBase64, REMOTE_SHELL_CWD_MAX_BYTES);
    const promptGeneration = normalizeBoundedInteger(value.promptGeneration, 1, Number.MAX_SAFE_INTEGER);
    if (
      !isAbsoluteShellPath(cwd) ||
      (value.physicalCwdOutputBase64 !== '' && !isAbsoluteShellPath(physicalCwd)) ||
      (value.homeBase64 !== '' && !isAbsoluteShellPath(homeDirectory)) ||
      (shell !== 'sh' && shell !== 'ash' && promptGeneration === null)
    ) {
      return null;
    }

    return {
      ...base,
      event: eventName,
      cwd,
      physicalCwd,
      homeDirectory,
      ...(promptGeneration === null ? {} : { promptGeneration }),
    };
  }

  if (eventName === 'line-state') {
    const lineLength = normalizeBoundedInteger(value.lineLength, 0, REMOTE_SHELL_LINE_LENGTH_MAX);
    const cursorIndex = normalizeBoundedInteger(value.cursorIndex, 0, REMOTE_SHELL_LINE_LENGTH_MAX);
    const promptGeneration = normalizeBoundedInteger(value.promptGeneration, 0, Number.MAX_SAFE_INTEGER);
    if (lineLength === null || cursorIndex === null || promptGeneration === null || cursorIndex > lineLength) {
      return null;
    }

    return { ...base, event: eventName, lineLength, cursorIndex, promptGeneration };
  }

  const command = decodeBoundedBase64Utf8(value.commandBase64, REMOTE_SHELL_COMMAND_MAX_BYTES);
  const commandId = normalizeCommandId(value.commandId);
  if (!command || containsAsciiControlCharacter(command) || !commandId) {
    return null;
  }

  if (eventName === 'command-start' || eventName === 'foreground-command') {
    return { ...base, event: eventName, command, commandId };
  }

  const exitCode = normalizeBoundedInteger(value.exitCode, 0, 255);
  const durationMs = normalizeBoundedInteger(value.durationMs, 0, Number.MAX_SAFE_INTEGER);
  if (exitCode === null || durationMs === null) {
    return null;
  }

  return { ...base, event: eventName, command, commandId, exitCode, durationMs };
};

/**
 * Validates a Linux path without trimming legal whitespace or normalizing symbolic-link components.
 * @param value Decoded bounded path.
 * @returns Whether the path is absolute and contains no NUL byte.
 */
const isAbsoluteShellPath = (value: string | null): value is string =>
  value !== null && value.startsWith('/') && !value.includes('\u0000');

/**
 * Validates a bounded, unique helper capability list.
 *
 * @param value Unknown capabilities payload.
 * @returns Normalized capabilities, or null when malformed.
 */
const normalizeCapabilities = (value: unknown): RemoteShellCapability[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > REMOTE_SHELL_CAPABILITY_MAX_COUNT) {
    return null;
  }

  const capabilities: RemoteShellCapability[] = [];
  for (const capability of value) {
    if (
      typeof capability !== 'string' ||
      !REMOTE_SHELL_CAPABILITY_SET.has(capability as RemoteShellCapability) ||
      capabilities.includes(capability as RemoteShellCapability)
    ) {
      return null;
    }
    capabilities.push(capability as RemoteShellCapability);
  }

  return capabilities;
};

/**
 * Decodes one canonical base64 field as bounded, valid UTF-8.
 *
 * Dynamic shell strings use base64 inside the JSON envelope so valid path control
 * characters cannot corrupt the helper event syntax.
 *
 * @param value Unknown base64 field.
 * @param maxBytes Maximum decoded UTF-8 bytes.
 * @returns Decoded string, or null when malformed or oversized.
 */
const decodeBoundedBase64Utf8 = (value: unknown, maxBytes: number): string | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    return null;
  }

  try {
    const decodedBytes = Buffer.from(value, 'base64');
    if (decodedBytes.length === 0 || decodedBytes.length > maxBytes || decodedBytes.toString('base64') !== value) {
      return null;
    }

    return new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
  } catch {
    return null;
  }
};

/**
 * Validates a command lifecycle identifier without accepting arbitrary payload data.
 *
 * @param value Unknown command identifier.
 * @returns Valid identifier, or null when malformed.
 */
const normalizeCommandId = (value: unknown): string | null => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !REMOTE_SHELL_COMMAND_ID_PATTERN.test(value)
  ) {
    return null;
  }

  return value;
};

/**
 * Detects ASCII control bytes that are forbidden in sanitized executable names.
 *
 * @param value Decoded helper command field.
 * @returns True when the string contains C0 controls or DEL.
 */
const containsAsciiControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
};

/**
 * Narrows an unknown value to a finite integer inside an inclusive range.
 *
 * @param value Unknown numeric field.
 * @param minimum Inclusive minimum.
 * @param maximum Inclusive maximum.
 * @returns Valid integer, or null when outside the contract.
 */
const normalizeBoundedInteger = (value: unknown, minimum: number, maximum: number): number | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return null;
  }

  return value;
};

/**
 * Finds the end index of the payload inside a completed OSC sequence.
 *
 * @param sequence Completed OSC sequence.
 * @returns Exclusive payload end index.
 */
const readSequencePayloadEnd = (sequence: string): number => {
  if (sequence.endsWith(STRING_TERMINATOR)) {
    return sequence.length - STRING_TERMINATOR.length;
  }

  return sequence.length - BELL.length;
};

/**
 * Narrows an unknown value to a plain object record.
 *
 * @param value Unknown parsed JSON value.
 * @returns True when the value can be read as a record.
 */
const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};
