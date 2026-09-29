import { DEFAULT_SETTINGS_VALUES, type SshTerminalServerMessage } from '@cosmosh/api-contract';

import { RemoteShellEventOscParser } from '../../ssh/remote-shell-events.js';
import { SshSessionService } from '../../ssh/session-service.js';
import {
  createCredentialFillState,
  type CredentialFillState,
  observeCredentialFillOutput,
} from '../credential-fill.js';
import { createShellContext, resolveShellPermissions, type ShellContextState } from '../shell-context.js';

/** Minimal live-session fields touched by the production credential and input handlers. */
export type CredentialTestSession = {
  remoteShellEventParser: RemoteShellEventOscParser;
  shellContext: ShellContextState;
  sessionId: string;
  loginPassword: string | null;
  credentialFillState: CredentialFillState;
  disposed: boolean;
  socket: { readyState: number; OPEN: number } | null;
  stream: { destroyed: boolean; write(data: string): void };
  commandCount: number;
  remoteEnhancementsRuntimeState: 'disabled';
};

/** Production methods exposed for tests; database, WebSocket and PTY boundaries are isolated. */
type CredentialServiceHarness = {
  sessions: Map<string, CredentialTestSession>;
  fillLoginPassword(session: CredentialTestSession, token: string): Promise<void>;
  handleVisibleShellOutput(session: CredentialTestSession, output: string): void;
  handleShellOutput(session: CredentialTestSession, output: string): void;
  handleClientMessage(session: CredentialTestSession, payload: Buffer): void;
};

/**
 * Builds a test receiver from the actual session prototype without opening a WebSocket listener.
 *
 * @param options Optional actual PTY stream, saved fixture password and database read behavior.
 * @returns Actual production handlers with captured transport writes and messages.
 */
export const createCredentialServiceHarness = (
  options: {
    password?: string | null;
    stream?: CredentialTestSession['stream'];
    readSettings?: () => Promise<Array<{ payloadJson: string }>>;
  } = {},
) => {
  const writes: string[] = [];
  const sent: SshTerminalServerMessage[] = [];
  const session: CredentialTestSession = {
    remoteShellEventParser: new RemoteShellEventOscParser(),
    shellContext: createShellContext(
      'credential-fixture-session',
      resolveShellPermissions(DEFAULT_SETTINGS_VALUES, false),
      false,
    ),
    sessionId: 'credential-fixture-session',
    loginPassword: options.password === undefined ? 'PRIVATE_FIXTURE_PASSWORD_SENTINEL' : options.password,
    credentialFillState: observeCredentialFillOutput(createCredentialFillState(), 'Password: ', Date.now()),
    disposed: false,
    socket: { OPEN: 1, readyState: 1 },
    stream: options.stream ?? {
      destroyed: false,
      write: (data): void => {
        writes.push(data);
      },
    },
    commandCount: 0,
    remoteEnhancementsRuntimeState: 'disabled',
  };
  const service = Object.assign(Object.create(SshSessionService.prototype) as CredentialServiceHarness, {
    sessions: new Map([[session.sessionId, session]]),
    getDbClient: () => ({ $queryRaw: options.readSettings ?? (async () => []) }),
    sendServerMessage: (_session: CredentialTestSession, message: SshTerminalServerMessage): void => {
      sent.push(message);
    },
    scheduleHistorySync: (): void => {},
  });
  return { service, session, sent, writes };
};
