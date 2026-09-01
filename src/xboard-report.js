import { normalizeXboardUuid, parseXboardUserMap } from './xboard-snapshot.js';

function toNonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function toIntervalMs(value, defaultSeconds) {
	const seconds = value === undefined ? defaultSeconds : Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export function createXboardReportAccumulator({ fetchImpl = fetch, log = () => {}, completionClock = Date.now } = {}) {
	let traffic = new Map();
	let alive = new Map();
	let lastTrafficUpdatedAtByUuid = new Map();
	let inFlight = null;
	let lastTrafficPushedAt = null;
	let lastAlivePushedAt = null;
	let nextAllowedPushAt = 0;
	let consecutiveFailures = 0;

	function addTraffic(uuid, uploadBytes = 0, downloadBytes = 0, now = Date.now()) {
		const key = normalizeXboardUuid(uuid);
		if (!key) return false;
		const upload = toNonNegativeInteger(uploadBytes);
		const download = toNonNegativeInteger(downloadBytes);
		if (!upload && !download) return false;
		const current = traffic.get(key) || [0, 0];
		current[0] += upload;
		current[1] += download;
		traffic.set(key, current);
		const updatedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
		lastTrafficUpdatedAtByUuid.set(key, Math.max(lastTrafficUpdatedAtByUuid.get(key) ?? updatedAt, updatedAt));
		return true;
	}

	function addAlive(uuid, ip) {
		const key = normalizeXboardUuid(uuid);
		const clientIp = String(ip || '').trim();
		if (!key || !clientIp || clientIp.length > 128) return false;
		const ips = alive.get(key) || new Set();
		ips.add(clientIp);
		alive.set(key, ips);
		return true;
	}

	function snapshot() {
		return {
			traffic: Object.fromEntries([...traffic.entries()].map(([uuid, value]) => [uuid, [...value]])),
			alive: Object.fromEntries([...alive.entries()].map(([uuid, ips]) => [uuid, [...ips]])),
		};
	}

	function mergeTraffic(batch, now = Date.now()) {
		for (const [uuid, value] of batch.entries()) addTraffic(uuid, value[0], value[1], now);
	}

	function mergeAlive(batch) {
		for (const [uuid, ips] of batch.entries()) {
			for (const ip of ips) addAlive(uuid, ip);
		}
	}

	function discardExpiredOrphanTraffic(userMap, now, env) {
		const configuredTtl = Number(env.XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS);
		const orphanTtlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.max(60, configuredTtl) : 900;
		const orphanTtlMs = orphanTtlSeconds * 1000;
		for (const uuid of traffic.keys()) {
			if (userMap[uuid]) continue;
			const lastUpdatedAt = lastTrafficUpdatedAtByUuid.get(uuid) ?? now;
			if (now - lastUpdatedAt < orphanTtlMs) continue;
			traffic.delete(uuid);
			lastTrafficUpdatedAtByUuid.delete(uuid);
			log('[Xboard上报] 丢弃已撤权用户的过期未推送流量');
		}
	}

	async function push(env = {}, userMapValue = {}, now = Date.now(), force = false) {
		if (inFlight) {
			if (!force) return inFlight;
			await inFlight;
		}

		const userMap = parseXboardUserMap(userMapValue);
		discardExpiredOrphanTraffic(userMap, now, env);
		if (!traffic.size && !alive.size) return false;

		const apiBase = String(env.XBOARD_API_BASE || '').replace(/\/$/, '');
		const nodeId = String(env.XBOARD_NODE_ID || '').trim();
		const token = String(env.XBOARD_SERVER_TOKEN || '').trim();
		if (!apiBase || !nodeId || !token) return false;

		const trafficIntervalMs = toIntervalMs(env.XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS, 60);
		const aliveIntervalMs = toIntervalMs(env.XBOARD_ONLINE_PUSH_INTERVAL_SECONDS, 60);
		const trafficDue = traffic.size > 0 && (force || (trafficIntervalMs > 0 && (lastTrafficPushedAt === null || now - lastTrafficPushedAt >= trafficIntervalMs)));
		const aliveDue = alive.size > 0 && (force || (aliveIntervalMs > 0 && (lastAlivePushedAt === null || now - lastAlivePushedAt >= aliveIntervalMs)));
		const anyDue = trafficDue || aliveDue;
		if (!anyDue) return false;
		const includeTraffic = traffic.size > 0 && anyDue;
		const includeAlive = alive.size > 0 && anyDue;
		if (!force && now < nextAllowedPushAt) return false;

		const trafficBatch = new Map();
		const aliveBatch = new Map();
		const report = {};
		if (includeTraffic) {
			const body = {};
			for (const [uuid, value] of traffic.entries()) {
				const userId = userMap[uuid];
				if (!userId) continue;
				trafficBatch.set(uuid, [...value]);
				traffic.delete(uuid);
				lastTrafficUpdatedAtByUuid.delete(uuid);
				const key = String(userId);
				const aggregate = body[key] || [0, 0];
				aggregate[0] += value[0];
				aggregate[1] += value[1];
				body[key] = aggregate;
			}
			if (trafficBatch.size) report.traffic = body;
		}
		if (includeAlive) {
			const body = {};
			for (const [uuid, ips] of alive.entries()) {
				const userId = userMap[uuid];
				if (!userId) continue;
				const copiedIps = new Set(ips);
				aliveBatch.set(uuid, copiedIps);
				alive.delete(uuid);
				const key = String(userId);
				const aggregate = new Set(body[key] || []);
				for (const ip of copiedIps) aggregate.add(ip);
				body[key] = [...aggregate];
			}
			if (aliveBatch.size) report.alive = body;
		}
		if (!Object.keys(report).length) return false;

		inFlight = (async () => {
			try {
				const url = `${apiBase}/api/v2/server/report?node_id=${encodeURIComponent(nodeId)}&token=${encodeURIComponent(token)}`;
				const response = await fetchImpl(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(report),
				});
				if (!response || !response.ok) throw new Error(`Xboard report failed: HTTP ${response?.status ?? 'unknown'}`);
				if (trafficBatch.size) lastTrafficPushedAt = now;
				if (aliveBatch.size) lastAlivePushedAt = now;
				consecutiveFailures = 0;
				nextAllowedPushAt = 0;
				return true;
			} catch (error) {
				const completedAtValue = Number(completionClock());
				const completedAt = Number.isFinite(completedAtValue) ? completedAtValue : Date.now();
				mergeTraffic(trafficBatch, completedAt);
				mergeAlive(aliveBatch);
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

	return { addTraffic, addAlive, snapshot, push, flush };
}