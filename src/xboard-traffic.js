import { normalizeXboardUuid, parseXboardUserMap } from './xboard-snapshot.js';

export function createTrafficAccumulator({ fetchImpl = fetch, log = () => {}, completionClock = Date.now } = {}) {
	let traffic = new Map();
	let lastUpdatedAtByUuid = new Map();
	let inFlight = null;
	let lastPushedAt = 0;
	let nextAllowedPushAt = 0;
	let consecutiveFailures = 0;
	function add(uuid, uploadBytes = 0, downloadBytes = 0, now = Date.now()) {
		const key = normalizeXboardUuid(uuid);
		if (!key) return;
		const upload = Number.isFinite(Number(uploadBytes)) ? Math.max(0, Math.trunc(Number(uploadBytes))) : 0;
		const download = Number.isFinite(Number(downloadBytes)) ? Math.max(0, Math.trunc(Number(downloadBytes))) : 0;
		if (!upload && !download) return;
		const current = traffic.get(key) || [0, 0];
		current[0] += upload;
		current[1] += download;
		traffic.set(key, current);
		const updatedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
		lastUpdatedAtByUuid.set(key, Math.max(lastUpdatedAtByUuid.get(key) ?? updatedAt, updatedAt));
	}

	function snapshot() {
		return Object.fromEntries([...traffic.entries()].map(([uuid, value]) => [uuid, [...value]]));
	}

	function merge(batch, now = Date.now()) {
		for (const [uuid, value] of batch.entries()) add(uuid, value[0], value[1], now);
	}

	async function push(env = {}, userMapValue = {}, now = Date.now(), force = false) {
		if (inFlight) {
			if (!force) return inFlight;
			await inFlight;
		}
		if (traffic.size === 0) return false;

		const userMap = parseXboardUserMap(userMapValue);
		const configuredOrphanTtl = Number(env.XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS);
		const orphanTtlSeconds = Number.isFinite(configuredOrphanTtl) && configuredOrphanTtl > 0
			? Math.max(60, configuredOrphanTtl)
			: 900;
		const orphanTtlMs = orphanTtlSeconds * 1000;
		for (const uuid of traffic.keys()) {
			if (userMap[uuid]) continue;
			const lastUpdatedAt = lastUpdatedAtByUuid.get(uuid) ?? now;
			if (now - lastUpdatedAt >= orphanTtlMs) {
				traffic.delete(uuid);
				lastUpdatedAtByUuid.delete(uuid);
				log(`[Xboard流量] 丢弃已撤权 UUID 的过期未推送流量: ${uuid.slice(0, 8)}…`);
			}
		}
		if (traffic.size === 0) return false;

		const apiBase = String(env.XBOARD_API_BASE || '').replace(/\/$/, '');
		const nodeId = String(env.XBOARD_NODE_ID || '').trim();
		const token = String(env.XBOARD_SERVER_TOKEN || '').trim();
		if (!apiBase || !nodeId || !token) return false;
		const intervalMs = Math.max(0, Number(env.XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS ?? 60) * 1000 || 0);
		if (!force && (now < nextAllowedPushAt || (lastPushedAt && now - lastPushedAt < intervalMs))) return false;

		const batch = new Map();
		const body = {};
		for (const [uuid, value] of traffic.entries()) {
			const userID = userMap[uuid];
			if (!userID) continue;
			batch.set(uuid, [...value]);
			traffic.delete(uuid);
			lastUpdatedAtByUuid.delete(uuid);
			const key = String(userID);
			const aggregate = body[key] || [0, 0];
			aggregate[0] += value[0];
			aggregate[1] += value[1];
			body[key] = aggregate;
		}
		if (batch.size === 0) return false;

		inFlight = (async () => {
			try {
				const url = `${apiBase}/api/v1/server/UniProxy/push?node_id=${encodeURIComponent(nodeId)}&node_type=vless&token=${encodeURIComponent(token)}`;
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response || !response.ok) throw new Error(`Xboard traffic push failed: HTTP ${response?.status ?? 'unknown'}`);
				lastPushedAt = now;
				consecutiveFailures = 0;
				nextAllowedPushAt = 0;
				return true;
			} catch (error) {
				const completedAtValue = Number(completionClock());
				const completedAt = Number.isFinite(completedAtValue) ? completedAtValue : Date.now();
				merge(batch, completedAt);
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
