import test from 'node:test';
import assert from 'node:assert/strict';

import {
  解析Xboard快照,
  读取Xboard白名单,
  重置Xboard状态,
  解析VLESSUUID,
  校验VLESSUUID,
  累加Xboard流量,
  推送Xboard流量,
  获取Xboard流量快照,
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

function snapshot(uuids = [UUID_A], userMap = { [UUID_A]: 1 }, overrides = {}) {
  return JSON.stringify({
    version: 1,
    generatedAt: '2026-07-23T12:34:56+00:00',
    serverId: 9,
    uuids,
    userMap,
    ...overrides,
  });
}

function assertFailClosed(result, messagePattern = null) {
  assert.equal(result.mode, 'xboard');
  assert.deepEqual([...result.uuids], []);
  assert.deepEqual(result.userMap, {});
  assert.equal(result.failClosed, true);
  assert.equal(result.stale, false);
  if (messagePattern) assert.match(result.error, messagePattern);
}

test.beforeEach(() => {
  重置Xboard状态();
});

test('解析 schema v1 snapshot，并规范化 UUID 和用户映射', () => {
  const parsed = 解析Xboard快照(snapshot(
    [UUID_B.toUpperCase(), UUID_A],
    { [UUID_A.toUpperCase()]: 7, [UUID_B]: 8 },
  ), 1_000);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.generatedAt, '2026-07-23T12:34:56+00:00');
  assert.equal(parsed.serverId, 9);
  assert.deepEqual([...parsed.uuids], [UUID_A, UUID_B]);
  assert.deepEqual(parsed.userMap, { [UUID_A]: 7, [UUID_B]: 8 });
  assert.equal(parsed.loadedAt, 1_000);
});

test('schema v1 拒绝错误版本、非法 UUID、重复 UUID 和非法元数据', () => {
  assert.throws(() => 解析Xboard快照(snapshot(undefined, undefined, { version: '1' })), /version/i);
  assert.throws(() => 解析Xboard快照(snapshot([UUID_A, 'invalid'], { [UUID_A]: 1, invalid: 2 })), /uuid/i);
  assert.throws(() => 解析Xboard快照(snapshot([UUID_A, UUID_A.toUpperCase()], { [UUID_A]: 1 })), /duplicate/i);
  assert.throws(() => 解析Xboard快照(snapshot(undefined, undefined, { generatedAt: 'not-a-date' })), /generatedAt/i);
  assert.throws(() => 解析Xboard快照(snapshot(undefined, undefined, { serverId: 0 })), /serverId/i);
  assert.throws(() => 解析Xboard快照(snapshot(undefined, undefined, { serverId: '9' })), /serverId/i);
});

test('schema v1 要求 uuids 与 userMap 集合完全一致且用户 ID 为正整数', () => {
  assert.throws(() => 解析Xboard快照(snapshot([UUID_A, UUID_B], { [UUID_A]: 1 })), /same UUID set/i);
  assert.throws(() => 解析Xboard快照(snapshot([UUID_A], { [UUID_A]: 0 })), /user ID/i);
  assert.throws(() => 解析Xboard快照(snapshot([UUID_A], { [UUID_A]: 1.5 })), /user ID/i);
  assert.throws(() => 解析Xboard快照(snapshot([UUID_A], { [UUID_A]: 1, [UUID_B]: 2 })), /same UUID set/i);
});

test('有 XBOARD_KV 时只读取固定 snapshot key，不读取任何 Secret fallback', async () => {
  const store = kv({ 'xboard:snapshot': snapshot() });
  const result = await 读取Xboard白名单({
    XBOARD_KV: store,
    XBOARD_UUIDS: UUID_B,
    XBOARD_USER_MAP: JSON.stringify({ [UUID_B]: 2 }),
  }, 2_000);

  assert.equal(result.mode, 'xboard');
  assert.deepEqual([...result.uuids], [UUID_A]);
  assert.deepEqual(result.userMap, { [UUID_A]: 1 });
  assert.deepEqual(store.calls, ['xboard:snapshot']);
});

test('没有 XBOARD_KV 时保持个人单 UUID 模式，忽略旧 Secret 变量', async () => {
  const result = await 读取Xboard白名单({
    XBOARD_UUIDS: UUID_B,
    XBOARD_USER_MAP: JSON.stringify({ [UUID_B]: 2 }),
  }, 3_000);

  assert.equal(result.mode, 'personal');
  assert.equal(result.uuids, null);
  assert.deepEqual(result.userMap, {});
});

test('仅 KV 读取异常可复用未超过 600 秒的旧快照，超过后 fail-closed', async () => {
  const first = await 读取Xboard白名单({ XBOARD_KV: kv({ 'xboard:snapshot': snapshot() }) }, 10_000);
  assert.deepEqual([...first.uuids], [UUID_A]);

  const badStore = kv({}, new Error('KV unavailable'));
  const staleButAllowed = await 读取Xboard白名单({ XBOARD_KV: badStore }, 10_000 + 590_000, true);
  assert.deepEqual([...staleButAllowed.uuids], [UUID_A]);
  assert.equal(staleButAllowed.stale, true);
  assert.equal(staleButAllowed.failClosed, false);

  const expired = await 读取Xboard白名单({ XBOARD_KV: badStore }, 10_000 + 601_000, true);
  assert.equal(expired.mode, 'xboard');
  assert.deepEqual([...expired.uuids], []);
  assert.equal(expired.failClosed, true);
  assert.equal(expired.stale, true);
});

test('KV 成功返回缺失或无效快照时立即 fail-closed，不复用旧缓存', async () => {
  await 读取Xboard白名单({ XBOARD_KV: kv({ 'xboard:snapshot': snapshot() }) }, 10_000);

  for (const invalidValue of [null, '', '{', snapshot(undefined, undefined, { version: 2 })]) {
    const result = await 读取Xboard白名单({ XBOARD_KV: kv({ 'xboard:snapshot': invalidValue }) }, 20_000, true);
    assertFailClosed(result);
  }

  const afterInvalidReadFailure = await 读取Xboard白名单(
    { XBOARD_KV: kv({}, new Error('KV unavailable')) },
    21_000,
    true,
  );
  assert.deepEqual([...afterInvalidReadFailure.uuids], []);
  assert.equal(afterInvalidReadFailure.failClosed, true);
  assert.equal(afterInvalidReadFailure.stale, true);
});
test('解析并校验实际 VLESS UUID，而不是默认个人 UUID', () => {
  const bytes = vlessHeader(UUID_B);
  assert.equal(解析VLESSUUID(bytes), UUID_B);
  assert.equal(校验VLESSUUID(bytes, UUID_A, { mode: 'xboard', uuids: new Set([UUID_B]) }), UUID_B);
  assert.equal(校验VLESSUUID(bytes, UUID_A, { mode: 'xboard', uuids: new Set([UUID_A]) }), null);
  assert.equal(校验VLESSUUID(vlessHeader(UUID_A), UUID_A, { mode: 'personal', uuids: null }), UUID_A);
});

test('现有 VLESS 解析器和 WS early-data 使用白名单中的实际 UUID', () => {
  const access = { mode: 'xboard', uuids: new Set([UUID_B]) };
  const parsed = 解析魏烈思请求(vlessHeader(UUID_B), UUID_A, access);
  assert.equal(parsed.hasError, false);
  assert.equal(parsed.uuid, UUID_B);
  assert.equal(是有效WS早期数据(vlessHeader(UUID_B), UUID_A, access), true);
  assert.equal(是有效WS早期数据(vlessHeader(UUID_A), UUID_A, access), false);
});
test('流量推送按 Xboard 用户聚合，非 2xx 时将批次合并回活动 Map', async () => {
  累加Xboard流量(UUID_A, 100, 200);
  累加Xboard流量(UUID_A, 50, 25);
  累加Xboard流量(UUID_B, 10, 20);

  const requests = [];
  const env = {
    XBOARD_API_BASE: 'https://xboard.example.com/',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
  };
  const userMap = { [UUID_A]: 7 };

  await assert.rejects(
    推送Xboard流量(env, userMap, 50_000, async (url, init) => {
      requests.push({ url, init });
      return new Response('no', { status: 503 });
    }),
    /503/,
  );

  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [150, 225], [UUID_B]: [10, 20] });

  await 推送Xboard流量(env, userMap, 51_000, async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  });

  assert.match(requests[1].url, /\/api\/v1\/server\/UniProxy\/push\?/);
  assert.match(requests[1].url, /node_id=9/);
  assert.match(requests[1].url, /node_type=vless/);
  assert.match(requests[1].url, /token=secret/);
  assert.deepEqual(JSON.parse(requests[1].init.body), { 7: [150, 225] });
  assert.deepEqual(获取Xboard流量快照(), { [UUID_B]: [10, 20] });
});




test('快照缺失时不会读取 legacy 双 key', async () => {
  const store = kv({
    'xboard:uuids': JSON.stringify([UUID_A]),
    'xboard:user_map': JSON.stringify({ [UUID_A]: 1 }),
  });

  const result = await 读取Xboard白名单({ XBOARD_KV: store }, 4_000);

  assert.equal(result.mode, 'xboard');
  assert.deepEqual([...result.uuids], []);
  assert.equal(result.failClosed, true);
  assert.deepEqual(store.calls, ['xboard:snapshot']);
});

test('XHTTP VLESS 首包使用 Xboard 访问上下文中的 UUID', async () => {
  const header = vlessHeader(UUID_B);
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(header);
      controller.close();
    },
  }).getReader();

  const result = await 读取XHTTP首包(reader, UUID_A, { mode: 'xboard', uuids: new Set([UUID_B]) });

  assert.equal(result?.协议, 'vless');
  assert.equal(result?.uuid, UUID_B);
});

test('XHTTP VLESS 首包拒绝未列入 Xboard 快照的 UUID', async () => {
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(vlessHeader(UUID_B));
      controller.close();
    },
  }).getReader();

  const result = await 读取XHTTP首包(reader, UUID_A, { mode: 'xboard', uuids: new Set([UUID_A]) });

  assert.equal(result, null);
});




test('流量记录器只接受通过 Xboard 快照认证的 UUID', async () => {
  const waits = [];
  const ctx = { waitUntil(task) { waits.push(task); } };
  const env = {};
  const access = { mode: 'xboard', uuids: new Set([UUID_B]), userMap: { [UUID_B]: 2 } };

  assert.equal(创建Xboard流量记录器(UUID_A, access, env, ctx), null);
  assert.equal(创建Xboard流量记录器(UUID_B, { mode: 'personal', uuids: null }, env, ctx), null);

  const recorder = 创建Xboard流量记录器(UUID_B, access, env, ctx);
  recorder.上传(12);
  recorder.下载(34);
  await Promise.all(waits);

  assert.deepEqual(获取Xboard流量快照(), { [UUID_B]: [12, 34] });
});

test('连接关闭时的强制尾批次绕过常规推送间隔', async () => {
  const env = {
    XBOARD_API_BASE: 'https://xboard.example.com',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '60',
  };
  const userMap = { [UUID_A]: 7 };
  const requests = [];
  const send = async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  };

  累加Xboard流量(UUID_A, 10, 20);
  await 推送Xboard流量(env, userMap, 1_000, send);
  累加Xboard流量(UUID_A, 5, 7);

  assert.equal(await 推送Xboard流量(env, userMap, 2_000, send), false);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [5, 7] });
  assert.equal(await 推送Xboard流量(env, userMap, 2_000, send, true), true);
  assert.deepEqual(JSON.parse(requests[1].init.body), { 7: [5, 7] });
  assert.deepEqual(获取Xboard流量快照(), {});
});

test('强制尾批次会等待在途推送并继续发送期间新增流量', async () => {
  const env = {
    XBOARD_API_BASE: 'https://xboard.example.com',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '60',
  };
  const userMap = { [UUID_A]: 7 };
  const requests = [];
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });

  累加Xboard流量(UUID_A, 10, 20);
  const firstPush = 推送Xboard流量(env, userMap, 1_000, async (url, init) => {
    requests.push({ url, init });
    await firstResponse;
    return new Response('{}', { status: 200 });
  });
  await Promise.resolve();
  累加Xboard流量(UUID_A, 5, 7);
  const forcedFlush = 推送Xboard流量(env, userMap, 2_000, async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  }, true);

  releaseFirst();
  await Promise.all([firstPush, forcedFlush]);

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0].init.body), { 7: [10, 20] });
  assert.deepEqual(JSON.parse(requests[1].init.body), { 7: [5, 7] });
  assert.deepEqual(获取Xboard流量快照(), {});
});
test('推送进行中产生的新流量保留在活动 Map，并可在下一批继续推送', async () => {
  const env = {
    XBOARD_API_BASE: 'https://xboard.example.com',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
  };
  const userMap = { [UUID_A]: 7 };
  const requests = [];
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });

  累加Xboard流量(UUID_A, 10, 20);
  const firstPush = 推送Xboard流量(env, userMap, 60_000, async (url, init) => {
    requests.push({ url, init });
    await firstResponse;
    return new Response('{}', { status: 200 });
  });

  await Promise.resolve();
  累加Xboard流量(UUID_A, 5, 7);
  const inFlightPush = 推送Xboard流量(env, userMap, 60_001, async () => {
    throw new Error('in-flight push must be reused');
  });

  releaseFirst();
  await Promise.all([firstPush, inFlightPush]);

  assert.deepEqual(JSON.parse(requests[0].init.body), { 7: [10, 20] });
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [5, 7] });

  await 推送Xboard流量(env, userMap, 61_000, async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  });

  assert.deepEqual(JSON.parse(requests[1].init.body), { 7: [5, 7] });
  assert.deepEqual(获取Xboard流量快照(), {});
});
function trafficEnv(overrides = {}) {
  return {
    XBOARD_API_BASE: 'https://xboard.example',
    XBOARD_NODE_ID: '1',
    XBOARD_SERVER_TOKEN: 'token',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
    ...overrides,
  };
}

test('默认 900 秒 TTL：孤儿流量在边界前保留且不 fetch，在边界丢弃', async () => {
  let fetchCalls = 0;
  const noFetch = async () => {
    fetchCalls++;
    throw new Error('orphan traffic must not fetch');
  };

  累加Xboard流量(UUID_A, 100, 200, 0);
  assert.equal(await 推送Xboard流量(trafficEnv(), {}, 899_999, noFetch, true), false);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [100, 200] });

  assert.equal(await 推送Xboard流量(trafficEnv(), {}, 900_000, noFetch, true), false);
  assert.deepEqual(获取Xboard流量快照(), {});
  assert.equal(fetchCalls, 0);
});

test('孤儿流量超过默认 TTL 时丢弃且不 fetch', async () => {
  let fetchCalls = 0;
  累加Xboard流量(UUID_A, 100, 200, 0);

  assert.equal(await 推送Xboard流量(trafficEnv(), {}, 900_001, async () => {
    fetchCalls++;
    throw new Error('orphan traffic must not fetch');
  }, true), false);

  assert.deepEqual(获取Xboard流量快照(), {});
  assert.equal(fetchCalls, 0);
});

test('有限有效 TTL 最小 clamp 为 60 秒', async () => {
  const env = trafficEnv({ XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '1' });
  const noFetch = async () => { throw new Error('orphan traffic must not fetch'); };

  累加Xboard流量(UUID_A, 1, 2, 0);
  await 推送Xboard流量(env, {}, 59_999, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [1, 2] });

  await 推送Xboard流量(env, {}, 60_000, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), {});
});

test('缺失或无效 TTL 安全回退到默认 900 秒', async () => {
  for (const invalidValue of [undefined, '', 'not-a-number', '0', '-5', 'Infinity']) {
    重置Xboard状态();
    const env = trafficEnv();
    if (invalidValue !== undefined) env.XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS = invalidValue;
    const noFetch = async () => { throw new Error('orphan traffic must not fetch'); };

    累加Xboard流量(UUID_A, 1, 2, 0);
    await 推送Xboard流量(env, {}, 899_999, noFetch, true);
    assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [1, 2] }, `value ${String(invalidValue)} must retain before 900 seconds`);

    await 推送Xboard流量(env, {}, 900_000, noFetch, true);
    assert.deepEqual(获取Xboard流量快照(), {}, `value ${String(invalidValue)} must expire at 900 seconds`);
  }
});

test('缺 credentials 时仍清理到期 orphan，mapped traffic 保留且不 fetch', async () => {
  let fetchCalls = 0;
  累加Xboard流量(UUID_A, 10, 20, 0);
  累加Xboard流量(UUID_B, 30, 40, 0);

  assert.equal(await 推送Xboard流量({
    XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '60',
  }, { [UUID_B]: 42 }, 60_000, async () => {
    fetchCalls++;
    throw new Error('credential gate must not fetch');
  }), false);

  assert.deepEqual(获取Xboard流量快照(), { [UUID_B]: [30, 40] });
  assert.equal(fetchCalls, 0);
});

test('interval gate 时仍清理到期 orphan，mapped traffic 保留且不额外 fetch', async () => {
  const env = trafficEnv({
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '3600',
    XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '60',
  });
  let gatedFetchCalls = 0;

  累加Xboard流量(UUID_A, 1, 2, 0);
  await 推送Xboard流量(env, { [UUID_A]: 42 }, 1_000, async () => new Response('{}', { status: 200 }));

  累加Xboard流量(UUID_A, 10, 20, 0);
  累加Xboard流量(UUID_B, 30, 40, 0);
  assert.equal(await 推送Xboard流量(env, { [UUID_B]: 42 }, 60_000, async () => {
    gatedFetchCalls++;
    throw new Error('interval gate must not fetch');
  }), false);

  assert.deepEqual(获取Xboard流量快照(), { [UUID_B]: [30, 40] });
  assert.equal(gatedFetchCalls, 0);
});

test('backoff gate 时仍清理到期 orphan，mapped traffic 保留且不额外 fetch', async () => {
  const env = trafficEnv({ XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '60' });
  累加Xboard流量(UUID_A, 10, 20, 60_000);

  await assert.rejects(推送Xboard流量(env, { [UUID_A]: 42 }, 60_000, async () => (
    new Response('synthetic failure', { status: 503 })
  ), false, () => 60_000), /503/);

  累加Xboard流量(UUID_B, 30, 40, 0);
  let gatedFetchCalls = 0;
  assert.equal(await 推送Xboard流量(env, { [UUID_A]: 42 }, 60_500, async () => {
    gatedFetchCalls++;
    throw new Error('backoff gate must not fetch');
  }), false);

  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [10, 20] });
  assert.equal(gatedFetchCalls, 0);
});

test('当前 userMap 中的有效流量仍按用户聚合发送，成功后缓存清空', async () => {
  const requests = [];
  累加Xboard流量(UUID_A, 100, 200, 0);
  累加Xboard流量(UUID_B, 10, 20, 10);

  assert.equal(await 推送Xboard流量(trafficEnv(), { [UUID_A]: 42, [UUID_B]: 42 }, 1_000, async (url, init) => {
    requests.push({ url, init });
    return new Response('{}', { status: 200 });
  }, true), true);

  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { 42: [110, 220] });
  assert.deepEqual(获取Xboard流量快照(), {});

  累加Xboard流量(UUID_A, 1, 2, 0);
  await 推送Xboard流量(trafficEnv(), {}, 900_000, async () => {
    throw new Error('orphan traffic must not fetch');
  }, true);
  assert.deepEqual(获取Xboard流量快照(), {}, 'successful batches must delete stale timestamp metadata');
});

test('长 in-flight 的合法 batch 非 2xx 后从真正失败时刻刷新 TTL', async () => {
  const env = trafficEnv({ XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '60' });
  let completionNow = 10_000;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  累加Xboard流量(UUID_A, 10, 20, 0);

  const push = 推送Xboard流量(env, { [UUID_A]: 42 }, 10_000, async () => {
    await fetchGate;
    return new Response('synthetic failure', { status: 503 });
  }, true, () => completionNow);
  await Promise.resolve();
  completionNow = 120_000;
  releaseFetch();

  await assert.rejects(push, /503/);
  const noFetch = async () => { throw new Error('orphan traffic must not fetch'); };
  await 推送Xboard流量(env, {}, 120_000, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [10, 20] });

  await 推送Xboard流量(env, {}, 179_999, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [10, 20] });

  await 推送Xboard流量(env, {}, 180_000, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), {});
});

test('合法 batch 抛错后合并回缓存', async () => {
  累加Xboard流量(UUID_A, 10, 20, 0);

  await assert.rejects(推送Xboard流量(trafficEnv(), { [UUID_A]: 42 }, 1_000, async () => {
    throw new Error('synthetic fetch failure');
  }, true), /synthetic fetch failure/);

  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [10, 20] });
});

test('失败回并不丢并发新增流量，且不会倒退更晚的 timestamp', async () => {
  const env = trafficEnv({ XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS: '60' });
  let completionNow = 10_000;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  累加Xboard流量(UUID_A, 10, 20, 0);

  const push = 推送Xboard流量(env, { [UUID_A]: 42 }, 10_000, async () => {
    await fetchGate;
    return new Response('synthetic failure', { status: 503 });
  }, true, () => completionNow);
  await Promise.resolve();
  completionNow = 120_000;
  累加Xboard流量(UUID_A, 5, 7, 130_000);
  releaseFetch();

  await assert.rejects(push, /503/);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [15, 27] });

  const noFetch = async () => { throw new Error('orphan traffic must not fetch'); };
  await 推送Xboard流量(env, {}, 189_999, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), { [UUID_A]: [15, 27] });

  await 推送Xboard流量(env, {}, 190_000, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), {});
});

test('reset 清空流量状态，公开快照只暴露 synthetic aggregate', async () => {
  累加Xboard流量(UUID_A, 10, 20, 123_456);
  const snapshotValue = 获取Xboard流量快照();
  assert.deepEqual(snapshotValue, { [UUID_A]: [10, 20] });
  assert.deepEqual(Object.keys(snapshotValue), [UUID_A]);
  assert.equal(JSON.stringify(snapshotValue).includes('timestamp'), false);
  assert.equal(JSON.stringify(snapshotValue).includes('123456'), false);

  重置Xboard状态();
  assert.deepEqual(获取Xboard流量快照(), {});

  累加Xboard流量(UUID_A, 1, 2, 0);
  await 推送Xboard流量(trafficEnv(), {}, 900_000, async () => {
    throw new Error('orphan traffic must not fetch');
  }, true);
  assert.deepEqual(获取Xboard流量快照(), {}, 'reset must delete stale timestamp metadata');
});

test('孤儿过期清理同时删除 timestamp 元数据', async () => {
  const noFetch = async () => { throw new Error('orphan traffic must not fetch'); };
  累加Xboard流量(UUID_A, 10, 20, 1_000_000);
  await 推送Xboard流量(trafficEnv(), {}, 1_900_000, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), {});

  累加Xboard流量(UUID_A, 1, 2, 0);
  await 推送Xboard流量(trafficEnv(), {}, 900_000, noFetch, true);
  assert.deepEqual(获取Xboard流量快照(), {}, 'expired orphan cleanup must delete stale timestamp metadata');
});
