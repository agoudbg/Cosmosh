import assert from 'node:assert/strict';
import test from 'node:test';

import { createI18n, loadBackendInshellisenseMessages } from './i18n-bridge.js';

const asRecord = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);

  return value as Record<string, unknown>;
};

test('loads generated backend inshellisense messages from MessagePack asset', () => {
  const messages = loadBackendInshellisenseMessages('@cosmosh/i18n/locales/en/backend-inshellisense.msgpack');
  const completionMessages = asRecord(messages.completion);
  const descriptions = asRecord(completionMessages.inshellisenseDescriptions);

  assert.equal(typeof descriptions['docker_exec_--detach_71bb8413'], 'string');
});

test('falls back to English generated completion descriptions when zh-CN extension is empty', () => {
  const i18n = createI18n({ locale: 'zh-CN', fallbackLocale: 'en' });

  assert.equal(
    i18n.t('completion.inshellisenseDescriptions.docker_exec_--detach_71bb8413'),
    'Detached mode: run command in the background',
  );
});
