const XBOARD_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_CACHE_MS = 30 * 1000, DEFAULT_MAX_STALE_MS = 10 * 60 * 1000;
const XBOARD_SNAPSHOT_KEY = 'xboard:snapshot', MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
let snapshotCache = null;

export function normalizeXboardUuid(value) {
	const uuid = String(value || '').trim().toLowerCase();
	return XBOARD_UUID_V4_PATTERN.test(uuid) ? uuid : null;
}

export function parseXboardUuidList(value) {
	let values = value;
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return [];
		try { values = JSON.parse(text) }
		catch (_) { values = text.split(/[\s,]+/) }
	}
	if (!Array.isArray(values)) return [];
	return [...new Set(values.map(normalizeXboardUuid).filter(Boolean))].sort();
}

export function parseXboardUserMap(value, allowedUUIDs = null) {
	let source = value;
	if (typeof source === 'string') {
		try { source = JSON.parse(source || '{}') }
		catch (_) { return {} }
	}
	if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
	const result = {};
	for (const [rawUUID, rawUserID] of Object.entries(source)) {
		const uuid = normalizeXboardUuid(rawUUID);
		const userID = Number(rawUserID);
		if (!uuid || !Number.isSafeInteger(userID) || userID <= 0) continue;
		if (allowedUUIDs && !allowedUUIDs.has(uuid)) continue;
		result[uuid] = userID;
	}
	return result;
}

export function parseXboardSnapshot(text, now = Date.now()) {
	const source = typeof text === 'string' ? JSON.parse(text) : text;
	if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid Xboard snapshot');
	if (source.version !== 1) throw new Error('Invalid Xboard snapshot version');
	if (typeof source.generatedAt !== 'string' || !source.generatedAt.trim() || !Number.isFinite(Date.parse(source.generatedAt))) {
		throw new Error('Invalid Xboard snapshot generatedAt');
	}
	if (source.serverId !== null && (!Number.isSafeInteger(source.serverId) || source.serverId <= 0)) {
		throw new Error('Invalid Xboard snapshot serverId');
	}
	if (!Array.isArray(source.uuids)) throw new Error('Invalid Xboard snapshot UUID list');
	if (!source.userMap || typeof source.userMap !== 'object' || Array.isArray(source.userMap)) {
		throw new Error('Invalid Xboard snapshot userMap');
	}

	const normalizedUUIDs = [];
	const uuidSet = new Set();
	for (const rawUUID of source.uuids) {
		const uuid = normalizeXboardUuid(rawUUID);
		if (!uuid) throw new Error('Invalid UUID in Xboard snapshot');
		if (uuidSet.has(uuid)) throw new Error('Duplicate UUID in Xboard snapshot');
		uuidSet.add(uuid);
		normalizedUUIDs.push(uuid);
	}

	const normalizedUserMap = new Map();
	for (const [rawUUID, rawUserID] of Object.entries(source.userMap)) {
		const uuid = normalizeXboardUuid(rawUUID);
		if (!uuid) throw new Error('Invalid UUID in Xboard snapshot userMap');
		if (normalizedUserMap.has(uuid)) throw new Error('Duplicate UUID in Xboard snapshot userMap');
		if (!Number.isSafeInteger(rawUserID) || rawUserID <= 0) throw new Error('Invalid user ID in Xboard snapshot');
		normalizedUserMap.set(uuid, rawUserID);
	}
	if (uuidSet.size !== normalizedUserMap.size || [...uuidSet].some(uuid => !normalizedUserMap.has(uuid))) {
		throw new Error('Xboard snapshot uuids and userMap must contain the same UUID set');
	}

	const uuidList = [...uuidSet].sort();
	return {
		mode: 'xboard',
		version: 1,
		generatedAt: source.generatedAt,
		serverId: source.serverId,
		uuids: new Set(uuidList),
		userMap: Object.fromEntries(uuidList.map(uuid => [uuid, normalizedUserMap.get(uuid)])),
		loadedAt: now,
		stale: false,
		failClosed: false,
	};
}

export function clearXboardSnapshotCache() {
	snapshotCache = null;
}

async function secureTokenEquals(actual, expected) {
	const encoder = new TextEncoder();
	const [actualDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(actual)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	]);
	const actualBytes = new Uint8Array(actualDigest), expectedBytes = new Uint8Array(expectedDigest);
	let difference = 0;
	for (let index = 0; index < actualBytes.length; index++) difference |= actualBytes[index] ^ expectedBytes[index];
	return difference === 0;
}

async function readLimitedRequestText(request, maxBytes = MAX_SNAPSHOT_BYTES) {
	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RangeError('Snapshot payload is too large');
	if (!request.body) return '';

	const reader = request.body.getReader(), chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
			total += chunk.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new RangeError('Snapshot payload is too large');
			}
			chunks.push(chunk);
		}
	} finally {
		try { reader.releaseLock() } catch (_) { }
	}

	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function snapshotUpdateResponse(status, message = '') {
	if (status === 204) return new Response(null, { status });
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}

export async function handleXboardSnapshotUpdate(request, env = {}) {
	if (request.method !== 'PUT') {
		const response = snapshotUpdateResponse(405, 'Method not allowed.');
		response.headers.set('Allow', 'PUT');
		return response;
	}

	const kv = env.XBOARD_KV;
	const expectedToken = String(env.EDGETUNNEL_SYNC_TOKEN || '').trim();
	if (!kv || typeof kv.put !== 'function' || !expectedToken) {
		return snapshotUpdateResponse(503, 'Snapshot update is not configured.');
	}

	const authorization = request.headers.get('Authorization') || '';
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	const actualToken = match ? match[1].trim() : '';
	if (!actualToken || !(await secureTokenEquals(actualToken, expectedToken))) {
		return snapshotUpdateResponse(401, 'Unauthorized.');
	}

	let parsed;
	try {
		parsed = parseXboardSnapshot(await readLimitedRequestText(request));
	} catch (error) {
		return snapshotUpdateResponse(error instanceof RangeError ? 413 : 400, 'Invalid snapshot.');
	}

	const configuredServerId = String(env.XBOARD_NODE_ID ?? '').trim();
	if (configuredServerId) {
		const expectedServerId = Number(configuredServerId);
		if (!Number.isSafeInteger(expectedServerId) || expectedServerId <= 0) {
			return snapshotUpdateResponse(503, 'Snapshot update is not configured.');
		}
		if (parsed.serverId !== expectedServerId) {
			return snapshotUpdateResponse(400, 'Invalid snapshot.');
		}
	}

	const canonicalSnapshot = JSON.stringify({
		version: 1,
		generatedAt: parsed.generatedAt,
		serverId: parsed.serverId,
		uuids: [...parsed.uuids],
		userMap: parsed.userMap,
	});
	try {
		await kv.put(XBOARD_SNAPSHOT_KEY, canonicalSnapshot);
	} catch (_) {
		return snapshotUpdateResponse(503, 'Snapshot update failed.');
	}
	clearXboardSnapshotCache();
	return snapshotUpdateResponse(204);
}
function copyXboardAccessContext(source, overrides = {}) {
	return {
		...source,
		uuids: source.uuids instanceof Set ? new Set(source.uuids) : source.uuids,
		userMap: { ...(source.userMap || {}) },
		...overrides,
	};
}

function createXboardFailClosedContext(now, error, stale = false) {
	return {
		mode: 'xboard', version: '', generatedAt: '', serverId: null, uuids: new Set(), userMap: {}, loadedAt: now,
		stale, failClosed: true, error: error?.message || String(error),
	};
}

function isXboardKvRequired(value) {
	if (value === true || value === 1) return true;
	if (typeof value !== 'string') return false;
	const normalized = value.trim().toLowerCase();
	return normalized === 'true' || normalized === '1';
}

export async function readXboardAccessContext(env = {}, now = Date.now(), force = false) {
	const kv = env.XBOARD_KV;
	if (!kv || typeof kv.get !== 'function') {
		if (isXboardKvRequired(env.XBOARD_KV_REQUIRED)) {
			return createXboardFailClosedContext(
				now,
				new Error('XBOARD_KV binding is required when XBOARD_KV_REQUIRED is enabled.'),
				false,
			);
		}
		return { mode: 'personal', version: '', generatedAt: '', serverId: null, uuids: null, userMap: {}, loadedAt: now, stale: false, failClosed: false };
	}

	const cacheMs = Math.max(0, Number(env.XBOARD_CACHE_TTL_SECONDS ?? 30) * 1000 || DEFAULT_CACHE_MS);
	const maxStaleMs = Math.max(cacheMs, Number(env.XBOARD_MAX_STALE_SECONDS ?? 600) * 1000 || DEFAULT_MAX_STALE_MS);
	if (!force && snapshotCache && now - snapshotCache.loadedAt < cacheMs) {
		return copyXboardAccessContext(snapshotCache);
	}

	let snapshotText;
	try {
		snapshotText = await kv.get('xboard:snapshot');
	} catch (error) {
		if (snapshotCache && now - snapshotCache.loadedAt <= maxStaleMs) {
			return copyXboardAccessContext(snapshotCache, { stale: true, error: error?.message || String(error) });
		}
		return createXboardFailClosedContext(now, error, true);
	}

	try {
		if (snapshotText === null || snapshotText === undefined || (typeof snapshotText === 'string' && snapshotText.trim() === '')) {
			throw new Error('Missing xboard:snapshot');
		}
		const result = parseXboardSnapshot(snapshotText, now);
		snapshotCache = result;
		return copyXboardAccessContext(result);
	} catch (error) {
		snapshotCache = null;
		return createXboardFailClosedContext(now, error, false);
	}
}
export function resetXboardSnapshotStateForTest() {
	clearXboardSnapshotCache();
}
