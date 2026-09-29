import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';

import type { ShellEditorRequest } from '@cosmosh/api-contract';

import { executeShellEditorRequest } from '../../ssh/editor-exec.js';
import { DeliveredTerminal } from '../../ssh/terminal-transport.js';
import { editorBinaryPath, EditorFixture, installFixtureEditor } from './editor-fixture.js';
import { openFixtureTerminal } from './fixture-client.js';

const shells = ['bash', 'zsh', 'fish'] as const;
before(async () => {
  for (const shell of shells) await installFixtureEditor(shell);
});

for (const shell of shells) {
  for (const roundTripLatencyMs of [0, 150, 300] as const) {
    test(
      shell + ' orders input and precise edits with ' + roundTripLatencyMs + ' ms added RTT',
      { timeout: 90_000 },
      async (t) => {
        const terminal = await openFixtureTerminal(
          shell,
          shell === 'fish' ? '/opt/cosmosh-fixture/fish-4.0.1/runtime/bin/fish' : undefined,
          { ...(shell === 'fish' ? { disableFishAutosuggestions: true } : {}), roundTripLatencyMs },
        );
        t.after(() => terminal.close());
        assert.ok(terminal.channel instanceof DeliveredTerminal);
        const transport = terminal.channel;
        const fixture = new EditorFixture(terminal, shell);
        const event = await fixture.prompt();
        assert.equal(event.available, true);
        assert.equal(transport.inputDelivery.sent, 0);
        const empty = await fixture.request('snapshot');
        assert.equal(empty.status, 'ok');
        if (empty.status !== 'ok') return;
        assert.deepEqual(
          await fixture.request('apply', empty.snapshot, { text: 'echo original', cursor: 13 }),
          { status: 'applied' },
          'sequence zero must be explicitly authorized before the first physical key',
        );
        const original = await fixture.request('snapshot');
        assert.equal(original.status, 'ok');
        if (original.status !== 'ok') return;
        const inputBoundary = await fixture.inputBoundary();
        const request: ShellEditorRequest = {
          requestId: randomUUID(),
          inputBoundary,
          operation: 'apply',
          includeDirectory: true,
          promptGeneration: event.promptGeneration,
          notification: event.notification,
          target: { instanceId: event.shellInstanceId, shell, pid: event.pid, startTime: event.startTime },
          expected: original.snapshot,
          replacement: { text: 'echo overwritten', cursor: 16 },
        };
        const lifetime = new AbortController();
        let dispatched = false;
        const rejected = await executeShellEditorRequest(terminal.client, editorBinaryPath(shell), request, {
          signal: lifetime.signal,
          isCurrent: () => true,
          trigger: () => {},
          authorize: async () => {
            dispatched = true;
            terminal.write('-new');
            assert.equal(await transport.waitForDelivery(transport.inputDelivery.sent, lifetime.signal), true);
            return await transport.authorizeEditor(request.requestId, inputBoundary, lifetime.signal);
          },
          revoke: () => transport.revokeEditor(request.requestId),
        });
        assert.equal(dispatched, true);
        assert.equal(rejected.status, 'stale');
        const retained = await fixture.request('snapshot');
        assert.equal(retained.status, 'ok');
        if (retained.status === 'ok')
          assert.deepEqual(retained.snapshot.buffer, { text: 'echo original-new', cursor: 17 });
        // A separate exec request can overtake the input channel. An old boundary must never observe or edit the new state.
        const stale = await executeShellEditorRequest(
          terminal.client,
          editorBinaryPath(shell),
          { ...request, requestId: randomUUID(), operation: 'snapshot', expected: undefined, replacement: undefined },
          {
            signal: lifetime.signal,
            isCurrent: () => true,
            trigger: () => {},
            authorize: async () => assert.fail('read-only request cannot authorize'),
            revoke: () => {},
          },
        );
        assert.equal(stale.status, 'stale');
        assert.equal(retained.status, 'ok');
        if (retained.status !== 'ok') return;
        const laterRequest: ShellEditorRequest = {
          ...request,
          requestId: randomUUID(),
          inputBoundary: await fixture.inputBoundary(),
          expected: retained.snapshot,
        };
        let authorized = false;
        const revoked = await executeShellEditorRequest(terminal.client, editorBinaryPath(shell), laterRequest, {
          signal: lifetime.signal,
          isCurrent: () => true,
          trigger: () => {},
          authorize: async () => {
            authorized = await transport.authorizeEditor(
              laterRequest.requestId,
              laterRequest.inputBoundary,
              lifetime.signal,
            );
            assert.equal(authorized, true);
            // This input arrives after the grant but before the worker receives the apply decision.
            // The remote authority must already be revoked even if the desktop's isCurrent check is stale.
            terminal.write('-later');
            assert.equal(await transport.waitForDelivery(transport.inputDelivery.sent, lifetime.signal), true);
            return true;
          },
          revoke: () => transport.revokeEditor(laterRequest.requestId),
        });
        assert.equal(authorized, true);
        // The extra delivery round trip may exceed the bounded worker deadline at 300 ms RTT.
        // An unconfirmed decision remains unknown and is never retried; the actual editor below
        // must still contain every new character and none of the old replacement.
        assert.ok(revoked.status === 'stale' || revoked.status === 'unknown');
        const final = await fixture.request('snapshot');
        assert.equal(final.status, 'ok');
        if (final.status === 'ok')
          assert.deepEqual(final.snapshot.buffer, { text: 'echo original-new-later', cursor: 23 });
        await fixture.cancel();
        const boundary = terminal.write("printf 'ORDER_%s\\n' READY\r");
        await terminal.waitFor(/ORDER_READY\r?\n/u, boundary);
      },
    );
  }
}
