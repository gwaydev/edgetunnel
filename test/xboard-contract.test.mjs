import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { 解析Xboard快照 } from '../_worker.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const fixtureUrl = new URL('../../Xboard/tests/Fixtures/EdgeTunnel/snapshot-v1.json', import.meta.url);

test('Xboard schema-v1 fixture is accepted by the worker snapshot parser', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const parsed = 解析Xboard快照(fixture, 1_000);

  assert.deepEqual(Object.keys(fixture), ['version', 'generatedAt', 'serverId', 'uuids', 'userMap']);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.generatedAt, '2026-08-01T00:00:00+00:00');
  assert.equal(parsed.serverId, 1);
  assert.deepEqual([...parsed.uuids], [UUID]);
  assert.deepEqual(parsed.userMap, { [UUID]: 42 });
});

test('worker snapshot parser rejects schemaVersion as a version alias', () => {
  assert.throws(() => 解析Xboard快照({
    schemaVersion: 1,
    generatedAt: '2026-08-01T00:00:00+00:00',
    serverId: 1,
    uuids: [UUID],
    userMap: { [UUID]: 42 },
  }), /version/i);
});
