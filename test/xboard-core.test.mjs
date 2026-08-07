import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseXboardSnapshot,
  readXboardAccessContext,
  resetXboardSnapshotStateForTest,
} from '../src/xboard-snapshot.js';
import { createTrafficAccumulator } from '../src/xboard-traffic.js';
import { createOnlineAccumulator, readXboardClientIp } from '../src/xboard-online.js';
import {
  解析VLESSUUID,
  解析魏烈思请求,
  是有效WS早期数据,
  读取XHTTP首包,
  创建Xboard流量记录器,
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
    version: 1,
    generatedAt: '2026-08-01T00:00:00+00:00',
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

function trafficEnv(overrides = {}) {
  return {
    XBOARD_API_BASE: 'https://xboard.example.com/',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
    ...overrides,
  };
}

function createTrafficHarness() {
  let activeFetch = async () => { throw new Error('missing test fetch'); };
  let completionClock = Date.now;
  const accumulator = createTrafficAccumulator({
    fetchImpl: (...args) => activeFetch(...args),
    log: () => {},
    completionClock: () => completionClock(),
  });
  return {
    add: accumulator.add,
    snapshot: accumulator.snapshot,
    push(env, userMap, now, fetchImpl = activeFetch, force = false, clock = Date.now) {
      activeFetch = fetchImpl;
      completionClock = clock;
      return force ? accumulator.flush(env, userMap, now) : accumulator.push(env, userMap, now);
    },
  };
}

test.beforeEach(() => resetXboardSnapshotStateForTest());

test('正常解析 Xboard 快照并建立 UUID 到用户 ID 的映射', () => {
  const result = parseXboardSnapshot(snapshot([UUID_B], { [UUID_B]: 42 }), 1_000);

  assert.equal(result.mode, 'xboard');
  assert.deepEqual([...result.uuids], [UUID_B]);
  assert.deepEqual(result.userMap, { [UUID_B]: 42 });
  assert.equal(result.failClosed, false);
});

test('非法快照被拒绝，版本别名不会绕过协议校验', () => {
  assert.throws(() => parseXboardSnapshot({
    schemaVersion: 1,
    generatedAt: '2026-08-01T00:00:00+00:00',
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

test('流量记录器只接受已认证 UUID，并按 Xboard 用户聚合', async () => {
  const traffic = createTrafficHarness();
  const waits = [];
  const ctx = { waitUntil(task) { waits.push(task); } };
  const access = { mode: 'xboard', uuids: new Set([UUID_B]), userMap: { [UUID_B]: 42 } };

  assert.equal(创建Xboard流量记录器(UUID_A, access, {}, ctx), null);
  const recorder = 创建Xboard流量记录器(UUID_B, access, {}, ctx, traffic);
  recorder.上传(12);
  recorder.下载(34);
  await Promise.all(waits);
  assert.deepEqual(traffic.snapshot(), { [UUID_B]: [12, 34] });
});

test('流量推送失败会回滚批次，成功后清空已发送缓存', async () => {
  const traffic = createTrafficHarness();
  traffic.add(UUID_A, 100, 200);
  traffic.add(UUID_A, 50, 25);
  const env = trafficEnv();
  const userMap = { [UUID_A]: 7 };

  await assert.rejects(traffic.push(env, userMap, 50_000, async () => new Response('failed', { status: 503 })), /503/);
  assert.deepEqual(traffic.snapshot(), { [UUID_A]: [150, 225] });

  const requests = [];
  assert.equal(await traffic.push(env, userMap, 51_000, async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  }), true);
  assert.deepEqual(JSON.parse(requests[0].init.body), { 7: [150, 225] });
  assert.deepEqual(traffic.snapshot(), {});
});

test('已撤权 UUID 的孤儿流量超过 TTL 后被清理且不会发送', async () => {
  const traffic = createTrafficHarness();
  traffic.add(UUID_A, 10, 20, 0);
  let fetchCalls = 0;
  const result = await traffic.push(
    trafficEnv({ XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '60' }),
    {},
    60_000,
    async () => { fetchCalls++; return new Response('{}'); },
    true,
  );
  assert.equal(result, false);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(traffic.snapshot(), {});
});

test('在线上报只读取 CF-Connecting-IP，按用户去重并使用 merge=1', async () => {
  const requests = [];
  const online = createOnlineAccumulator({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(readXboardClientIp(new Request('https://worker.example', {
    headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.8' },
  })), '203.0.113.7');
  assert.equal(readXboardClientIp(new Request('https://worker.example', {
    headers: { 'X-Forwarded-For': '198.51.100.8' },
  })), '');

  online.add(UUID_A, '203.0.113.7');
  online.add(UUID_A, '203.0.113.7');
  online.add(UUID_B, '198.51.100.8');
  await online.flush(trafficEnv(), { [UUID_A]: 42, [UUID_B]: 42 }, 1_000);

  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('merge'), '1');
  assert.deepEqual(JSON.parse(requests[0].init.body), { 42: ['203.0.113.7', '198.51.100.8'] });
  assert.deepEqual(online.snapshot(), {});
});

test('在线上报失败会退避，强制刷新可重试且不丢设备', async () => {
  let calls = 0;
  const online = createOnlineAccumulator({
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? new Response('failed', { status: 503 }) : new Response('{}', { status: 200 });
    },
  });
  online.add(UUID_A, '203.0.113.7');
  await assert.rejects(online.flush(trafficEnv(), { [UUID_A]: 42 }, 1_000), /503/);
  assert.deepEqual(online.snapshot(), { [UUID_A]: ['203.0.113.7'] });
  assert.equal(await online.push(trafficEnv(), { [UUID_A]: 42 }, 1_500), false);
  assert.equal(calls, 1);
  assert.equal(await online.flush(trafficEnv(), { [UUID_A]: 42 }, 1_500), true);
  assert.equal(calls, 2);
});

test('认证连接会按在线间隔刷新心跳，关闭时停止定时器', async () => {
  const waits = [];
  const timers = [];
  const cleared = [];
  const onlineCalls = { add: 0, push: 0, flush: 0 };
  const online = {
    add() { onlineCalls.add++; },
    async push() { onlineCalls.push++; },
    async flush() { onlineCalls.flush++; },
  };
  const traffic = { add() {}, push: async () => false, flush: async () => false };
  const timerApi = {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout(id) { cleared.push(id); },
  };
  const env = { ...trafficEnv(), XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '60' };
  const access = { mode: 'xboard', uuids: new Set([UUID_B]), userMap: { [UUID_B]: 42 } };
  const ctx = { waitUntil(task) { waits.push(task); } };
  const recorder = 创建Xboard流量记录器(UUID_B, access, env, ctx, traffic,
    new Request('https://worker.example', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), online, timerApi);

  await Promise.all(waits.splice(0));
  assert.equal(onlineCalls.add, 1);
  assert.equal(timers[0].delay, 60_000);
  await timers[0].callback();
  await Promise.all(waits.splice(0));
  assert.equal(onlineCalls.add, 2);
  await recorder.推送();
  await Promise.all(waits.splice(0));
  assert.deepEqual(cleared, [2]);
});

test('缺少 Xboard 回传配置时不发起外部请求', async () => {
  let calls = 0;
  const online = createOnlineAccumulator({ fetchImpl: async () => { calls++; return new Response('{}'); } });
  online.add(UUID_A, '203.0.113.7');
  assert.equal(await online.flush({}, { [UUID_A]: 42 }, 1_000), false);
  assert.equal(calls, 0);
});
