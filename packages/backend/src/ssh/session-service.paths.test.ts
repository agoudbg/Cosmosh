import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS_VALUES, type TerminalServerMessage } from '@cosmosh/api-contract';

import type { TerminalClientInboundMessage } from '../terminal/shared.js';
import { createShellContext, resolveShellPermissions } from '../terminal/shell-context.js';
import { SshSessionService } from './session-service.js';

test('legacy SSH completion cannot start a filename scan or send raw path insertion text', async () => {
  const session = {
    shellContext: {
      ...createShellContext('paths-test', resolveShellPermissions(DEFAULT_SETTINGS_VALUES, true), true),
      status: 'ready' as const,
      cwd: { logical: '/tmp', physical: '/tmp', home: '/home/user' },
    },
    socket: {},
    disposed: false,
    completionRecentCommands: [],
    t: (key: string) => key,
    client: { exec: () => assert.fail('legacy guessed-input completion must not read remote paths') },
  };
  const messages: TerminalServerMessage[] = [];
  const service = Object.create(SshSessionService.prototype) as {
    handleCompletionRequest(
      value: typeof session,
      message: Extract<TerminalClientInboundMessage, { type: 'completion-request' }>,
    ): Promise<void>;
    sendServerMessage(value: typeof session, message: TerminalServerMessage): void;
  };
  service.sendServerMessage = (_session, message) => {
    messages.push(message);
  };
  await service.handleCompletionRequest(session, {
    type: 'completion-request',
    requestId: 'test-path-query',
    linePrefix: 'cat ',
    cursorIndex: 4,
    includeHistory: false,
    includeBuiltInCommands: false,
    includePathSuggestions: true,
    trigger: 'manual',
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'completion-response');
  if (messages[0].type === 'completion-response') assert.deepEqual(messages[0].items, []);
});
