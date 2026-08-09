'use strict';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
};

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function maxBodyBytes() {
  const configured = Number(process.env.MAP_BODY_LIMIT_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BODY_BYTES;
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';
}

function mapIdFor(placeName, roomName) {
  return slug(placeName) + '--' + slug(roomName);
}

function validId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,40}--[a-z0-9-]{1,40}$/.test(id);
}

function validateMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'map must be a JSON object';
  if (map.map_version !== 1) return 'map_version must be 1';
  if (typeof map.location_name !== 'string' || !map.location_name.trim()) return 'location_name is required';
  if (typeof map.created_at !== 'string' || isNaN(Date.parse(map.created_at))) return 'created_at must be an ISO timestamp';
  if (!Array.isArray(map.waypoints) || map.waypoints.length === 0) return 'waypoints must be a non-empty array';
  for (let i = 0; i < map.waypoints.length; i++) {
    const w = map.waypoints[i];
    if (!w || typeof w !== 'object' || Array.isArray(w)) return 'waypoint ' + i + ' must be an object';
    for (const k of ['id', 'label', 'notes', 'transition_from_previous', 'photo_base64']) {
      if (typeof w[k] !== 'string') return 'waypoint ' + i + ' is missing string field "' + k + '"';
    }
    if (w.order !== i + 1) return 'waypoint ' + i + ' has wrong order (expected ' + (i + 1) + ')';
    if (!w.photo_base64.startsWith('data:image/jpeg;base64,')) return 'waypoint ' + i + ' photo_base64 must be a JPEG data URL';
  }
  return null;
}

function validateWrapper(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  if (typeof body.place_name !== 'string' || !body.place_name.trim()) return 'place_name is required';
  if (typeof body.room_name !== 'string' || !body.room_name.trim()) return 'room_name is required';
  return validateMap(body.map);
}

function normalizeWrapper(wrapper) {
  return {
    place_name: wrapper.place_name.trim(),
    room_name: wrapper.room_name.trim(),
    map: wrapper.map
  };
}

function summarize(entry) {
  const w = entry.wrapper;
  return {
    map_id: entry.map_id,
    place_name: w.place_name,
    room_name: w.room_name,
    location_name: w.map.location_name,
    created_at: w.map.created_at,
    waypoint_count: Array.isArray(w.map.waypoints) ? w.map.waypoints.length : 0
  };
}

function withCors(res) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sendJson(res, status, obj) {
  withCors(res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(obj));
}

function sendOptions(res) {
  withCors(res);
  res.statusCode = 204;
  res.end();
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    if (Buffer.byteLength(raw) > maxBodyBytes()) throw new ApiError(413, 'body too large');
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new ApiError(400, 'invalid JSON');
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBodyBytes()) throw new ApiError(413, 'body too large');
    chunks.push(buf);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new ApiError(400, 'invalid JSON');
  }
}

function placesFromSummaries(summaries) {
  const byPlace = new Map();
  for (const s of summaries) {
    if (!byPlace.has(s.place_name)) byPlace.set(s.place_name, []);
    byPlace.get(s.place_name).push({
      map_id: s.map_id,
      room_name: s.room_name,
      waypoint_count: s.waypoint_count,
      created_at: s.created_at
    });
  }
  return Array.from(byPlace.entries())
    .map(([place_name, rooms]) => ({
      place_name,
      rooms: rooms.sort((a, b) => a.room_name.localeCompare(b.room_name))
    }))
    .sort((a, b) => a.place_name.localeCompare(b.place_name));
}

function mapIdFromRequest(req, explicitId) {
  if (explicitId) return explicitId;
  if (req.query && typeof req.query.id === 'string') return req.query.id;
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const match = pathname.match(/^\/api\/maps\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function dispatch(res, fn) {
  try {
    await fn();
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    sendJson(res, status, { error: error.message || 'internal server error' });
  }
}

async function handlePlaces(req, res, storage) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  await dispatch(res, async () => {
    if (req.method !== 'GET') throw new ApiError(405, 'method not allowed');
    sendJson(res, 200, placesFromSummaries(await storage.listSummaries()));
  });
}

async function handleMapsCollection(req, res, storage) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  await dispatch(res, async () => {
    if (req.method === 'GET') {
      const summaries = await storage.listSummaries();
      sendJson(res, 200, summaries.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const problem = validateWrapper(body);
      if (problem) throw new ApiError(400, problem);
      const wrapper = normalizeWrapper(body);
      const mapId = mapIdFor(wrapper.place_name, wrapper.room_name);
      await storage.saveWrapper(mapId, wrapper);
      sendJson(res, 200, { map_id: mapId });
      return;
    }

    throw new ApiError(405, 'method not allowed');
  });
}

async function handleMapItem(req, res, storage, explicitId) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  await dispatch(res, async () => {
    const id = mapIdFromRequest(req, explicitId);
    if (!validId(id)) throw new ApiError(400, 'bad map id');

    if (req.method === 'GET') {
      const wrapper = await storage.getWrapper(id);
      if (!wrapper || !wrapper.map) throw new ApiError(404, 'map not found');
      sendJson(res, 200, wrapper.map);
      return;
    }

    if (req.method === 'DELETE') {
      const deleted = await storage.deleteWrapper(id);
      if (!deleted) throw new ApiError(404, 'map not found');
      sendJson(res, 200, { deleted: id });
      return;
    }

    throw new ApiError(405, 'method not allowed');
  });
}

module.exports = {
  ApiError,
  handleMapItem,
  handleMapsCollection,
  handlePlaces,
  mapIdFor,
  sendJson,
  summarize,
  validId,
  validateMap,
  validateWrapper
};
