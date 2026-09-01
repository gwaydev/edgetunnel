import test from 'node:test';
import assert from 'node:assert/strict';

import { createXboardReportAccumulator } from '../src/xboard-report.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function reportEnv(overrides = {}) {
  return {
    XBOARD_API_BASE: 'https://xboard.example.com/',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '60',
    XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '60',
    ...overrides,
  };
}

function response(status = 200) {
  return new Response('{}', { status });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('V2 report 在一次请求中合并 traffic 和 alive，并按用户聚合', async () => {
  const requests = [];
  const report = createXboardReportAccumulator({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response();
    },
  });

  report.addTraffic(UUID_A, 100, 200);
  report.addAlive(UUID_A, '203.0.113.7');
  report.addAlive(UUID_A, '203.0.113.7');
  report.addAlive(UUID_B, '198.51.100.8');

  assert.equal(await report.flush(reportEnv(), { [UUID_A]: 42, [UUID_B]: 42 }, 1_000), true);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/v2/server/report');
  assert.equal(url.searchParams.get('node_id'), '9');
  assert.equal(url.searchParams.get('token'), 'secret');
  assert.equal(url.searchParams.has('node_type'), false);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    traffic: { 42: [100, 200] },
    alive: { 42: ['203.0.113.7', '198.51.100.8'] },
  });
  assert.deepEqual(report.snapshot(), { traffic: {}, alive: {} });
});

test('时间戳为 0 的成功发送仍会正确遵守后续推送间隔', async () => {
  let calls = 0;
  const report = createXboardReportAccumulator({
    fetchImpl: async () => { calls++; return response(); },
  });
  const env = reportEnv();
  const map = { [UUID_A]: 42 };

  report.addTraffic(UUID_A, 1, 2);
  await report.flush(env, map, 0);
  report.addTraffic(UUID_A, 3, 4);
  assert.equal(await report.push(env, map, 1_000), false);
  assert.equal(calls, 1);
  assert.equal(await report.push(env, map, 60_000), true);
  assert.equal(calls, 2);
});

test('任一类别到期时，另一个类别的待发送数据随同 V2 请求捎带', async () => {
  const bodies = [];
  const report = createXboardReportAccumulator({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response();
    },
  });
  const env = reportEnv({
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '60',
    XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '120',
  });
  const map = { [UUID_A]: 42 };

  report.addTraffic(UUID_A, 1, 2);
  report.addAlive(UUID_A, '203.0.113.7');
  await report.flush(env, map, 0);

  report.addTraffic(UUID_A, 3, 4, 61_000);
  report.addAlive(UUID_A, '203.0.113.8');
  assert.equal(await report.push(env, map, 61_000), true);
  assert.deepEqual(bodies[1], {
    traffic: { 42: [3, 4] },
    alive: { 42: ['203.0.113.8'] },
  });
});

test('traffic 或 alive 单独存在时仍使用同一个 V2 endpoint', async () => {
  const requests = [];
  const report = createXboardReportAccumulator({
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return response();
    },
  });
  const env = reportEnv({
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
    XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '0',
  });
  const map = { [UUID_A]: 42 };

  report.addTraffic(UUID_A, 5, 6);
  await report.flush(env, map, 1_000);
  report.addAlive(UUID_A, '203.0.113.7');
  await report.flush(env, map, 2_000);

  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).pathname, '/api/v2/server/report');
  assert.deepEqual(requests[0].body, { traffic: { 42: [5, 6] } });
  assert.deepEqual(requests[1].body, { alive: { 42: ['203.0.113.7'] } });
});

test('traffic 和 alive 请求失败时完整回滚，并按 at-least-once 语义退避重试', async () => {
  let calls = 0;
  const report = createXboardReportAccumulator({
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? response(503) : response();
    },
  });
  const env = reportEnv({
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
    XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '0',
  });
  const map = { [UUID_A]: 42 };
  report.addTraffic(UUID_A, 10, 20);
  report.addAlive(UUID_A, '203.0.113.7');

  await assert.rejects(report.flush(env, map, 1_000), /503/);
  assert.deepEqual(report.snapshot(), {
    traffic: { [UUID_A]: [10, 20] },
    alive: { [UUID_A]: ['203.0.113.7'] },
  });
  assert.equal(await report.push(env, map, 1_500), false);
  assert.equal(calls, 1);
  assert.equal(await report.flush(env, map, 1_500), true);
  assert.equal(calls, 2);
  assert.deepEqual(report.snapshot(), { traffic: {}, alive: {} });
});

test('请求飞行中新增的数据不会被已完成批次清除', async () => {
  const pending = deferred();
  const requests = [];
  const report = createXboardReportAccumulator({
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return pending.promise;
    },
  });
  const env = reportEnv({
    XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS: '0',
    XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '0',
  });
  const map = { [UUID_A]: 42 };

  report.addTraffic(UUID_A, 1, 2);
  report.addAlive(UUID_A, '203.0.113.7');
  const first = report.flush(env, map, 1_000);
  report.addTraffic(UUID_A, 3, 4);
  report.addAlive(UUID_A, '203.0.113.8');
  pending.resolve(response());
  assert.equal(await first, true);
  assert.deepEqual(report.snapshot(), {
    traffic: { [UUID_A]: [3, 4] },
    alive: { [UUID_A]: ['203.0.113.8'] },
  });

  report.addTraffic(UUID_A, 5, 6);
  const second = report.flush(env, map, 2_000);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], {
    traffic: { 42: [8, 10] },
    alive: { 42: ['203.0.113.8'] },
  });
  await second;
});

test('未配置 Xboard 回传参数时不请求，过期孤儿流量会被丢弃', async () => {
  let calls = 0;
  let logged = '';
  const report = createXboardReportAccumulator({
    fetchImpl: async () => { calls++; return response(); },
    log: message => { logged += message; },
  });
  report.addTraffic(UUID_A, 10, 20, 0);
  report.addAlive(UUID_A, '203.0.113.7');
  assert.equal(await report.flush({}, {}, 901_000), false);
  assert.equal(calls, 0);
  assert.deepEqual(report.snapshot(), { traffic: {}, alive: { [UUID_A]: ['203.0.113.7'] } });
  assert.match(logged, /过期未推送流量/);
});
