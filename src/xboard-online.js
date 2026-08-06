import { normalizeXboardUuid, parseXboardUserMap } from './xboard-snapshot.js';

export function readXboardClientIp(request) {
	if (!request?.headers || typeof request.headers.get !== 'function') return '';

	const value = String(request.headers.get('CF-Connecting-IP') || '').trim();
	return value && value.length <= 128 ? value : '';
}

export function createOnlineAccumulator({ fetchImpl = fetch } = {}) {
	let devices = new Map();
	let inFlight = null;
	let lastPushedAt = 0;
	let nextAllowedPushAt = 0;
	let consecutiveFailures = 0;

	function add(uuid, ip) {
		const key = normalizeXboardUuid(uuid);
		const clientIp = String(ip || '').trim();
		if (!key || !clientIp || clientIp.length > 128) return false;

		const ips = devices.get(key) || new Set();
		ips.add(clientIp);
		devices.set(key, ips);
		return true;
	}

	function snapshot() {
		return Object.fromEntries([...devices.entries()].map(([uuid, ips]) => [uuid, [...ips]]));
	}

	function merge(batch) {
		for (const [uuid, ips] of batch.entries()) {
			for (const ip of ips) add(uuid, ip);
		}
	}

	async function push(env = {}, userMapValue = {}, now = Date.now(), force = false) {
		if (inFlight) {
			if (!force) return inFlight;
			await inFlight;
		}
		if (devices.size === 0) return false;

		const apiBase = String(env.XBOARD_API_BASE || '').replace(/\/$/, '');
		const nodeId = String(env.XBOARD_NODE_ID || '').trim();
		const token = String(env.XBOARD_SERVER_TOKEN || '').trim();
		if (!apiBase || !nodeId || !token) return false;

		const intervalMs = Math.max(0, Number(env.XBOARD_ONLINE_PUSH_INTERVAL_SECONDS ?? 60) * 1000 || 0);
		if (!force && (now < nextAllowedPushAt || (lastPushedAt && now - lastPushedAt < intervalMs))) return false;

		const userMap = parseXboardUserMap(userMapValue);
		const batch = new Map();
		const body = {};
		for (const [uuid, ips] of devices.entries()) {
			const userId = userMap[uuid];
			if (!userId) continue;

			const copiedIps = new Set(ips);
			batch.set(uuid, copiedIps);
			devices.delete(uuid);

			const key = String(userId);
			const aggregate = new Set(body[key] || []);
			for (const ip of copiedIps) aggregate.add(ip);
			body[key] = [...aggregate];
		}
		if (batch.size === 0) return false;

		inFlight = (async () => {
			try {
				const url = `${apiBase}/api/v1/server/UniProxy/alive?node_id=${encodeURIComponent(nodeId)}&node_type=vless&token=${encodeURIComponent(token)}&merge=1`;
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response || !response.ok) throw new Error(`Xboard alive push failed: HTTP ${response?.status ?? 'unknown'}`);
				lastPushedAt = now;
				consecutiveFailures = 0;
				nextAllowedPushAt = 0;
				return true;
			} catch (error) {
				merge(batch);
				consecutiveFailures++;
				nextAllowedPushAt = now + Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(consecutiveFailures - 1, 8)));
				throw error;
			} finally {
				inFlight = null;
			}
		})();

		return inFlight;
	}

	function flush(env = {}, userMapValue = {}, now = Date.now()) {
		return push(env, userMapValue, now, true);
	}

	return { add, snapshot, push, flush };
}
