import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseXboardSnapshot,
  handleXboardSnapshotUpdate,
  readXboardAccessContext,
  resetXboardSnapshotStateForTest,
} from '../src/xboard-snapshot.js';
import { readXboardClientIp } from '../src/xboard-online.js';
import worker from '../_worker.js';
import {
  解析VLESSUUID,
  解析魏烈思请求,
  是有效WS早期数据,
  读取XHTTP首包,
  创建Xboard流量记录器,
  创建Xboard授权监视器,
  是EdgeTunnel订阅路径,
  是Xboard服务端JSON订阅请求,
  创建Xboard订阅鉴权拒绝响应,
  校验Xboard订阅鉴权,
} from '../_worker.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function uuidBytes(uuid) {
  return Uint8Array.from(uuid.replaceAll('-', '').match(/../g).map((hex) => Number.parseInt(hex, 16)));
}

function vlessHeader(uuid) {
  const bytes = new Uint8Array(26);
  bytes[0] = 1;
  bytes.set(uuidBytes(uuid), 1);
  bytes[17] = 0;
  bytes[18] = 1;
  bytes[19] = 0;
  bytes[20] = 80;
  bytes[21] = 1;
  bytes.set([1, 1, 1, 1], 22);
  return bytes;
}

function snapshot(uuids = [UUID_A], userMap = { [UUID_A]: 1 }, overrides = {}) {
  return JSON.stringify({
    version: 2,
    generatedAt: '2099-08-01T00:00:00+00:00',
    leaseExpiresAt: '2099-08-01T12:00:00.000Z',
    serverId: 9,
    uuids,
    userMap,
    ...overrides,
  });
}

function kv(values, error = null) {
  const calls = [];
  return {
    calls,
    async get(key) {
      calls.push(key);
      if (error) throw error;
      return Object.hasOwn(values, key) ? values[key] : null;
    },
  };
}


test.beforeEach(() => resetXboardSnapshotStateForTest());

async function withWorkerRuntimeStubs(callback) {
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalFetch = globalThis.fetch;
  const pendingTasks = [];

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { subtle: { digest: async () => new Uint8Array(16).buffer } },
  });
  globalThis.fetch = async () => new Response('', { status: 200 });

  try {
    return await callback({
      waitUntil(task) {
        pendingTasks.push(Promise.resolve(task));
      },
      async flush() {
        await Promise.allSettled(pendingTasks);
      },
    });
  } finally {
    await Promise.allSettled(pendingTasks);
    globalThis.fetch = originalFetch;
    if (originalCryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
      delete globalThis.crypto;
    }
  }
}

function workerRequest(url, init = {}) {
  const request = new Request(url, init);
  Object.defineProperty(request, 'cf', { value: { colo: 'SFO', asn: 13335 } });
  return request;
}

test('订阅路由接受末尾斜杠，避免被误送入 XHTTP', () => {
  assert.equal(是EdgeTunnel订阅路径('/sub'), true);
  assert.equal(是EdgeTunnel订阅路径('/sub/'), true);
  assert.equal(是EdgeTunnel订阅路径('/SUB///'), true);
  assert.equal(是EdgeTunnel订阅路径('/subscription'), false);
});

test('强制 Xboard KV 模式无 ADMIN 时，服务端订阅可用且普通请求仍拒绝', async () => {
  await withWorkerRuntimeStubs(async ({ waitUntil, flush }) => {
    const values = new Map();
    const kvBinding = {
      async get(key) {
        return values.get(key) ?? null;
      },
      async put(key, value) {
        values.set(key, value);
      },
    };
    const env = {
      XBOARD_KV_REQUIRED: 'true',
      XBOARD_KV: kvBinding,
      EDGETUNNEL_SYNC_TOKEN: 'sync-secret',
    };

    const accepted = await worker.fetch(workerRequest('https://worker.example/sub?target=clash', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sync-secret',
        'User-Agent': 'Xboard-EdgeTunnel-Subscription/1.0',
      },
      body: JSON.stringify({ sync_token: 'sync-secret' }),
    }), env, { waitUntil });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('X-EdgeTunnel-Subscription-Route'), 'v3');
    assert.equal(accepted.headers.get('X-EdgeTunnel-Subscription-Auth'), 'accepted');
    assert.notEqual((await accepted.text()).trim(), 'noADMIN');

    const rejected = await worker.fetch(workerRequest('https://worker.example/sub?target=clash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_token: 'wrong-secret' }),
    }), env, { waitUntil });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('X-EdgeTunnel-Subscription-Auth'), 'rejected');

    const ordinary = await worker.fetch(workerRequest('https://worker.example/sub'), env, { waitUntil });
    assert.equal(ordinary.status, 404);

    await flush();
  });
});

test('配置同步令牌时，未授权的 Xboard JSON 订阅会明确拒绝', async () => {
  const env = { EDGETUNNEL_SYNC_TOKEN: 'sync-secret' };
  const request = new Request('https://worker.example/sub', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync_token: 'stale' }),
  });

  assert.equal(是Xboard服务端JSON订阅请求(request, env), true);
  assert.equal(await 校验Xboard订阅鉴权(request, env), false);
  const response = 创建Xboard订阅鉴权拒绝响应();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('X-EdgeTunnel-Subscription-Route'), 'v3');
  assert.equal(response.headers.get('X-EdgeTunnel-Subscription-Auth'), 'rejected');
  assert.equal(await response.text(), 'Unauthorized');

  assert.equal(是Xboard服务端JSON订阅请求(new Request('https://worker.example/sub'), env), false);
});

test('Xboard 自适应订阅支持 Bearer、专用请求头和 JSON 请求体', async () => {
  const env = { EDGETUNNEL_SYNC_TOKEN: 'sync-secret' };

  assert.equal(await 校验Xboard订阅鉴权(new Request('https://worker.example/sub', {
    headers: { Authorization: 'Bearer sync-secret' },
  }), env), true);
  assert.equal(await 校验Xboard订阅鉴权(new Request('https://worker.example/sub', {
    headers: { 'X-EdgeTunnel-Sync-Token': 'sync-secret' },
  }), env), true);
  assert.equal(await 校验Xboard订阅鉴权(new Request('https://worker.example/sub', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync_token: 'sync-secret' }),
  }), env), true);
  assert.equal(await 校验Xboard订阅鉴权(new Request('https://worker.example/sub', {
    method: 'POST',
    headers: { Authorization: 'Bearer stale', 'X-EdgeTunnel-Sync-Token': 'stale', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sync_token: 'stale' }),
  }), env), false);
});

test('正常解析 Xboard 快照并建立 UUID 到用户 ID 的映射', () => {
  const result = parseXboardSnapshot(snapshot([UUID_B], { [UUID_B]: 42 }), 1_000);

  assert.equal(result.mode, 'xboard');
  assert.deepEqual([...result.uuids], [UUID_B]);
  assert.deepEqual(result.userMap, { [UUID_B]: 42 });
  assert.equal(result.failClosed, false);
  assert.equal(result.version, 2);
  assert.equal(result.leaseExpiresAt, '2099-08-01T12:00:00.000Z');
});

test('schema v2 拒绝超过 12 小时加 60 秒时钟偏差的租约', () => {
  assert.throws(() => parseXboardSnapshot(snapshot([UUID_A], { [UUID_A]: 1 }, {
    generatedAt: '2099-08-01T00:00:00.000Z',
    leaseExpiresAt: '2099-08-01T12:01:01.000Z',
  }), Date.parse('2099-08-01T00:00:00.000Z')), /too long/i);
});

test('非法快照被拒绝，版本别名不会绕过协议校验', () => {
  assert.throws(() => parseXboardSnapshot({
    schemaversion: 2,
    generatedAt: '2099-08-01T00:00:00+00:00',
    leaseExpiresAt: '2099-08-01T12:00:00.000Z',
    serverId: 9,
    uuids: [UUID_A],
    userMap: { [UUID_A]: 1 },
  }), /version/i);
  assert.throws(() => parseXboardSnapshot(JSON.stringify({
    version: 1,
    generatedAt: 'invalid',
    serverId: 9,
    uuids: [UUID_A],
    userMap: { [UUID_A]: 1 },
  })), /generatedAt/i);
});

test('快照同步入口要求正确 Bearer Token 和 KV 写绑定', async () => {
  const writableKv = { async put() { throw new Error('must not write'); } };
  const missingToken = await handleXboardSnapshotUpdate(new Request('https://worker.example/__xboard/snapshot', {
    method: 'PUT', body: snapshot(),
  }), { XBOARD_KV: writableKv, EDGETUNNEL_SYNC_TOKEN: 'sync-secret-value' });
  assert.equal(missingToken.status, 401);

  const wrongToken = await handleXboardSnapshotUpdate(new Request('https://worker.example/__xboard/snapshot', {
    method: 'PUT', headers: { Authorization: 'Bearer wrong-token' }, body: snapshot(),
  }), { XBOARD_KV: writableKv, EDGETUNNEL_SYNC_TOKEN: 'sync-secret-value' });
  assert.equal(wrongToken.status, 401);

  const missingBinding = await handleXboardSnapshotUpdate(new Request('https://worker.example/__xboard/snapshot', {
    method: 'PUT', headers: { Authorization: 'Bearer sync-secret-value' }, body: snapshot(),
  }), { EDGETUNNEL_SYNC_TOKEN: 'sync-secret-value' });
  assert.equal(missingBinding.status, 503);
});

test('快照同步入口拒绝非法快照和不匹配的节点 ID', async () => {
  let writes = 0;
  const env = {
    EDGETUNNEL_SYNC_TOKEN: 'sync-secret-value',
    XBOARD_NODE_ID: '9',
    XBOARD_KV: { async put() { writes++; } },
  };
  const headers = { Authorization: 'Bearer sync-secret-value' };

  const invalid = await handleXboardSnapshotUpdate(new Request('https://worker.example/__xboard/snapshot', {
    method: 'PUT', headers, body: '{"version":2}',
  }), env);
  assert.equal(invalid.status, 400);

  const mismatch = await handleXboardSnapshotUpdate(new Request('https://worker.example/__xboard/snapshot', {
    method: 'PUT', headers, body: snapshot([UUID_A], { [UUID_A]: 1 }, { serverId: 10 }),
  }), env);
  assert.equal(mismatch.status, 400);
  assert.equal(writes, 0);
});

test('快照同步入口将规范化 schema v2 写入固定 KV 键', async () => {
  const writes = [];
  const response = await handleXboardSnapshotUpdate(new Request('https://worker.example/__xboard/snapshot', {
    method: 'PUT',
    headers: { Authorization: 'Bearer sync-secret-value' },
    body: snapshot([UUID_B, UUID_A], { [UUID_B]: 2, [UUID_A]: 1 }),
  }), {
    EDGETUNNEL_SYNC_TOKEN: 'sync-secret-value',
    XBOARD_NODE_ID: '9',
    XBOARD_LEASE_TTL_SECONDS: '999999',
    XBOARD_KV: { async put(key, value, options) { writes.push({ key, value, options }); } },
  });

  assert.equal(response.status, 204);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, 'xboard:snapshot');
  assert.deepEqual(writes[0].options, { expirationTtl: 43200 });
  assert.deepEqual(JSON.parse(writes[0].value), {
    version: 2,
    generatedAt: '2099-08-01T00:00:00+00:00',
    leaseExpiresAt: '2099-08-01T12:00:00.000Z',
    serverId: 9,
    uuids: [UUID_A, UUID_B],
    userMap: { [UUID_A]: 1, [UUID_B]: 2 },
  });
});
test('生产强制模式缺失 XBOARD_KV 时 fail-closed', async () => {
  const result = await readXboardAccessContext({ XBOARD_KV_REQUIRED: 'true' }, 2_000);

  assert.equal(result.mode, 'xboard');
  assert.equal(result.failClosed, true);
  assert.deepEqual([...result.uuids], []);
  assert.match(result.error, /XBOARD_KV binding is required/i);
});

test('KV 读取异常时仅在有效旧快照未过期时回退', async () => {
  const good = kv({ 'xboard:snapshot': snapshot() });
  const first = await readXboardAccessContext({ XBOARD_KV: good, XBOARD_KV_REQUIRED: 'true' }, 1_000);
  assert.deepEqual([...first.uuids], [UUID_A]);

  const failed = await readXboardAccessContext({
    XBOARD_KV: kv({}, new Error('KV unavailable')),
    XBOARD_KV_REQUIRED: 'true',
    XBOARD_MAX_STALE_SECONDS: '600',
  }, 2_000, true);
  assert.equal(failed.stale, true);
  assert.equal(failed.failClosed, false);
  assert.deepEqual(failed.userMap, { [UUID_A]: 1 });
});


test('v1 快照兼容读取但按 12 小时租约到期', () => {
  const generatedAt = '2026-08-01T00:00:00+00:00';
  const result = parseXboardSnapshot(JSON.stringify({ version: 1, generatedAt, serverId: 9, uuids: [UUID_A], userMap: { [UUID_A]: 1 } }), Date.parse('2026-08-01T11:59:59Z'));
  assert.equal(result.version, 1);
  assert.equal(result.leaseExpiresAt, '2026-08-01T12:00:00.000Z');
  assert.throws(() => parseXboardSnapshot(JSON.stringify({ version: 1, generatedAt, serverId: 9, uuids: [UUID_A], userMap: { [UUID_A]: 1 } }), Date.parse('2026-08-01T12:00:00Z')), /expired/i);
});

test('KV 缺失使用 30 秒负缓存且不会反复读取', async () => {
  let reads = 0;
  const binding = { async get() { reads++; return null; } };
  const first = await readXboardAccessContext({ XBOARD_KV: binding, XBOARD_KV_REQUIRED: 'true' }, 1000, true);
  const second = await readXboardAccessContext({ XBOARD_KV: binding, XBOARD_KV_REQUIRED: 'true' }, 2000, true);
  assert.equal(first.failClosed, true);
  assert.equal(second.failClosed, true);
  assert.equal(reads, 1);
});
test('VLESS、WS early-data 和 XHTTP 首包均使用快照中的实际 UUID', async () => {
  const access = { mode: 'xboard', uuids: new Set([UUID_B]) };
  assert.equal(解析VLESSUUID(vlessHeader(UUID_B)), UUID_B);
  assert.equal(解析魏烈思请求(vlessHeader(UUID_B), UUID_A, access).uuid, UUID_B);
  assert.equal(是有效WS早期数据(vlessHeader(UUID_B), UUID_A, access), true);
  assert.equal(是有效WS早期数据(vlessHeader(UUID_A), UUID_A, access), false);

  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(vlessHeader(UUID_B));
      controller.close();
    },
  }).getReader();
  const firstPacket = await 读取XHTTP首包(reader, UUID_A, access);
  assert.equal(firstPacket?.uuid, UUID_B);
});

test('流量记录器只接受已认证 UUID，并把在线和流量加入同一累加器', async () => {
  const waits = [];
  const calls = { alive: [], traffic: [], push: 0, flush: 0 };
  const accumulator = {
    addAlive(...args) { calls.alive.push(args); return true; },
    addTraffic(...args) { calls.traffic.push(args); return true; },
    async push() { calls.push++; return true; },
    async flush() { calls.flush++; return true; },
  };
  const ctx = { waitUntil(task) { waits.push(task); } };
  const access = { mode: 'xboard', uuids: new Set([UUID_B]), userMap: { [UUID_B]: 42 } };
  const request = new Request('https://worker.example', {
    headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.8' },
  });

  assert.equal(readXboardClientIp(request), '203.0.113.7');
  assert.equal(readXboardClientIp(new Request('https://worker.example', {
    headers: { 'X-Forwarded-For': '198.51.100.8' },
  })), '');
  assert.equal(创建Xboard流量记录器(UUID_A, access, {}, ctx), null);
  const recorder = 创建Xboard流量记录器(UUID_B, access, { XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '0' }, ctx, accumulator, request);
  await Promise.all(waits.splice(0));
  recorder.上传(12);
  recorder.下载(34);
  await Promise.all(waits.splice(0));

  assert.deepEqual(calls.alive, [
    [UUID_B, '203.0.113.7'],
    [UUID_B, '203.0.113.7'],
    [UUID_B, '203.0.113.7'],
  ]);
  assert.deepEqual(calls.traffic, [[UUID_B, 12, 0], [UUID_B, 0, 34]]);
  assert.equal(calls.push, 3);
  await recorder.推送();
  assert.equal(calls.flush, 1);
});

test('认证连接会按在线间隔刷新心跳，关闭时仅强制刷新一次并停止定时器', async () => {
  const waits = [];
  const timers = [];
  const cleared = [];
  const calls = { alive: 0, traffic: 0, push: 0, flush: 0 };
  const accumulator = {
    addAlive() { calls.alive++; return true; },
    addTraffic() { calls.traffic++; return true; },
    async push() { calls.push++; return true; },
    async flush() { calls.flush++; return true; },
  };
  const timerApi = {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout(id) { cleared.push(id); },
  };
  const env = { XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '60' };
  const access = { mode: 'xboard', uuids: new Set([UUID_B]), userMap: { [UUID_B]: 42 } };
  const ctx = { waitUntil(task) { waits.push(task); } };
  const recorder = 创建Xboard流量记录器(UUID_B, access, env, ctx, accumulator,
    new Request('https://worker.example', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), timerApi);

  await Promise.all(waits.splice(0));
  assert.equal(calls.alive, 1);
  assert.equal(timers[0].delay, 60_000);
  await timers[0].callback();
  await Promise.all(waits.splice(0));
  assert.equal(calls.alive, 2);
  assert.equal(calls.push, 2);
  await recorder.推送();
  await Promise.all(waits.splice(0));
  assert.equal(calls.flush, 1);
  assert.deepEqual(cleared, [2]);
});


test('已建立连接会在 UUID 被撤权后停止并触发关闭', async () => {
  const timers = [];
  const cleared = [];
  let snapshotText = snapshot([UUID_A], { [UUID_A]: 1 });
  const env = {
    XBOARD_KV_REQUIRED: 'true',
    XBOARD_ACCESS_REVALIDATION_INTERVAL_SECONDS: '5',
    XBOARD_KV: { async get() { return snapshotText; } },
  };
  const access = await readXboardAccessContext(env, Date.parse('2099-08-01T00:00:00Z'), true);
  let revoked = 0;
  const timerApi = {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout(id) { cleared.push(id); },
  };
  const monitor = 创建Xboard授权监视器(UUID_A, access, env, () => { revoked++; }, timerApi);

  assert.ok(monitor);
  assert.equal(timers[0].delay, 5_000);
  snapshotText = snapshot([], {});
  resetXboardSnapshotStateForTest();
  await timers[0].callback();

  assert.equal(revoked, 1);
  assert.deepEqual(cleared, []);
  assert.equal(timers.length, 1);
});

test('个人模式不会创建 Xboard 连接授权监视器', () => {
  assert.equal(创建Xboard授权监视器(UUID_A, { mode: 'personal' }, {}, () => {}), null);
});
