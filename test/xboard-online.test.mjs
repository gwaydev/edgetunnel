import test from 'node:test';
import assert from 'node:assert/strict';

const onlineModule = await import('../src/xboard-online.js').catch(() => ({}));
const { createOnlineAccumulator, readXboardClientIp } = onlineModule;

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function onlineEnv(overrides = {}) {
  return {
    XBOARD_API_BASE: 'https://xboard.example/',
    XBOARD_NODE_ID: '9',
    XBOARD_SERVER_TOKEN: 'secret',
    XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '0',
    ...overrides,
  };
}

test('客户端 IP 只读取 Cloudflare 注入的可信头', () => {
  assert.equal(typeof readXboardClientIp, 'function');

  assert.equal(readXboardClientIp(new Request('https://worker.example', {
    headers: {
      'CF-Connecting-IP': '203.0.113.7',
      'X-Forwarded-For': '198.51.100.8, 198.51.100.9',
    },
  })), '203.0.113.7');

  assert.equal(readXboardClientIp(new Request('https://worker.example', {
    headers: {
      'True-Client-IP': '198.51.100.7',
      'X-Real-IP': '198.51.100.8',
      'X-Forwarded-For': '198.51.100.9, 198.51.100.10',
    },
  })), '');
});

test('在线设备按 Xboard 用户聚合去重，并使用 merge=1 上报 alive', async () => {
  assert.equal(typeof createOnlineAccumulator, 'function');
  const requests = [];
  const online = createOnlineAccumulator({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response('{}', { status: 200 });
    },
    log: () => {},
  });

  online.add(UUID_A, '203.0.113.7');
  online.add(UUID_A, '203.0.113.7');
  online.add(UUID_B, '198.51.100.8');

  assert.equal(await online.flush(onlineEnv(), { [UUID_A]: 42, [UUID_B]: 42 }, 1_000), true);
  assert.equal(requests.length, 1);

  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/v1/server/UniProxy/alive');
  assert.equal(url.searchParams.get('node_id'), '9');
  assert.equal(url.searchParams.get('node_type'), 'vless');
  assert.equal(url.searchParams.get('merge'), '1');
  assert.equal(url.searchParams.get('token'), 'secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    42: ['203.0.113.7', '198.51.100.8'],
  });
  assert.deepEqual(online.snapshot(), {});
});

test('alive 非 2xx 时保留待上报设备，退避期间不重复请求，强制刷新可重试', async () => {
  assert.equal(typeof createOnlineAccumulator, 'function');
  let fetchCalls = 0;
  const online = createOnlineAccumulator({
    fetchImpl: async () => {
      fetchCalls++;
      return fetchCalls === 1
        ? new Response('synthetic failure', { status: 503 })
        : new Response('{}', { status: 200 });
    },
    log: () => {},
  });
  online.add(UUID_A, '203.0.113.7');

  await assert.rejects(
    online.push(onlineEnv({ XBOARD_ONLINE_PUSH_INTERVAL_SECONDS: '60' }), { [UUID_A]: 42 }, 1_000),
    /503/
  );
  assert.deepEqual(online.snapshot(), { [UUID_A]: ['203.0.113.7'] });

  assert.equal(await online.push(onlineEnv(), { [UUID_A]: 42 }, 1_500), false);
  assert.equal(fetchCalls, 1);

  assert.equal(await online.flush(onlineEnv(), { [UUID_A]: 42 }, 1_500), true);
  assert.equal(fetchCalls, 2);
  assert.deepEqual(online.snapshot(), {});
});

test('缺少 Xboard 服务端配置时不发送请求且保留设备状态', async () => {
  assert.equal(typeof createOnlineAccumulator, 'function');
  const online = createOnlineAccumulator({
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
    log: () => {},
  });
  online.add(UUID_A, '203.0.113.7');

  assert.equal(await online.push({}, { [UUID_A]: 42 }, 1_000), false);
  assert.deepEqual(online.snapshot(), { [UUID_A]: ['203.0.113.7'] });
});
