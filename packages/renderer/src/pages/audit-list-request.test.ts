import assert from 'node:assert/strict';
import test from 'node:test';

import { isLatestAuditListRequest } from './audit-list-request';

test('isLatestAuditListRequest accepts the current request', () => {
  assert.equal(isLatestAuditListRequest(3, 3), true);
});

test('isLatestAuditListRequest rejects an older request', () => {
  assert.equal(isLatestAuditListRequest(2, 3), false);
});
