import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalTerminalSessionService } from '../local-terminal/session-service.js';
import { SshSessionService } from '../ssh/session-service.js';
import type { CredentialFillState } from './credential-fill.js';

/** Input-only session shape; transport writes and timer scheduling are isolated boundaries. */
type InputSession = {
  sessionId: string;
  completionLineBuffer: string;
  completionRecentCommands: string[];
  completionWorkingDirectory: string;
  completionPendingCwdCommands: string[];
  credentialFillState: CredentialFillState;
  loginPassword: string | null;
  remoteEnhancementsRuntimeState: 'active' | 'disabled';
  remoteEnhancementsRuntimeContract: { capabilities: ['command-start'] };
  commandCount: number;
  stream: { write(data: string): void };
  pty: { write(data: string): void };
};

/** Actual protected receiver exposed only for testing the PTY transport boundary. */
type InputReceiver = {
  handleClientMessage(session: InputSession, payload: Buffer): void;
  sendCredentialFillOffer(session: InputSession): void;
};

const inputCases = [
  { name: 'password prompt', chunks: ['PRIVATE_TEST_', 'PASSWORD_SENTINEL', '\r'], passwordPrompt: true },
  { name: 'unrecognized program', chunks: ['PRIVATE_TEST_REPL_SENTINEL\r'], passwordPrompt: false },
  { name: 'ordinary unconfirmed command', chunks: ['echo test-command\r'], passwordPrompt: false },
  { name: 'multiple submitted lines', chunks: ['PRIVATE_TEST_ONE\r\nPRIVATE_TEST_TWO\n'], passwordPrompt: false },
  { name: 'cancelled input', chunks: ['PRIVATE_TEST_CANCELLED', '\x03'], passwordPrompt: false },
  { name: 'cursor editing and deletion', chunks: ['PRIVATE_TEST_EDIT', '\x1b[D', '\x7f', '\r'], passwordPrompt: false },
  { name: 'unconfirmed directory change', chunks: ['cd /tmp\r'], passwordPrompt: false },
] as const;

for (const [name, prototype] of [
  ['SSH', SshSessionService.prototype],
  ['local', LocalTerminalSessionService.prototype],
] as const) {
  for (const runtimeState of ['active', 'disabled'] as const) {
    for (const inputCase of inputCases) {
      test(`${name} input with ${runtimeState} helper never records ${inputCase.name}`, () => {
        const writes: string[] = [];
        const transport = {
          write: (data: string): void => {
            writes.push(data);
          },
        };
        const session: InputSession = {
          sessionId: 'privacy-test',
          completionLineBuffer: '',
          completionRecentCommands: ['echo retained-shell-history'],
          completionWorkingDirectory: '/fixture',
          completionPendingCwdCommands: [],
          credentialFillState: {
            outputTail: inputCase.passwordPrompt ? '[sudo] password for fixture: ' : '',
            offer: inputCase.passwordPrompt ? { token: 'prompt-token', expiresAt: Date.now() + 45_000 } : null,
          },
          loginPassword: null,
          remoteEnhancementsRuntimeState: runtimeState,
          remoteEnhancementsRuntimeContract: { capabilities: ['command-start'] },
          commandCount: 0,
          stream: transport,
          pty: transport,
        };
        const receiver = prototype as unknown as InputReceiver;
        const context = {
          scheduleHistorySync: (): void => {},
          sendServerMessage: (): void => {},
          sendCredentialFillOffer: (current: InputSession): void =>
            (SshSessionService.prototype as unknown as InputReceiver).sendCredentialFillOffer.call(context, current),
        };
        for (const chunk of inputCase.chunks) {
          receiver.handleClientMessage.call(
            context,
            session,
            Buffer.from(JSON.stringify({ type: 'input', data: chunk })),
          );
          assert.equal(session.completionLineBuffer, '', 'even an unfinished input must not be retained');
          assert.deepEqual(session.completionRecentCommands, ['echo retained-shell-history']);
          assert.equal(session.completionWorkingDirectory, '/fixture');
          assert.deepEqual(session.completionPendingCwdCommands, []);
        }
        assert.equal(writes.join(''), inputCase.chunks.join(''), 'all input bytes must reach the PTY unchanged');
      });
    }
  }
}
