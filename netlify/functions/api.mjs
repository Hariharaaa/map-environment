// PathMapper API as a Netlify Function, backed by Netlify Blobs.
// Mirrors the API in server.js (the local/self-hosted variant) — keep in sync.
//
//   GET    /api/places        -> [{ place_name, rooms: [{ map_id, room_name, waypoint_count, created_at }] }]
//   GET    /api/maps          -> flat list of room-map summaries
//   GET    /api/maps/:id      -> the room's map JSON (exact map_version-1 contract schema)
//   POST   /api/maps          -> body { place_name, room_name, map }; upserts, returns { map_id }
//   DELETE /api/maps/:id      -> removes a room map

import { getStore } from '@netlify/blobs';

const store = () => getStore({ name: 'pathmapper-maps', consistency: 'strong' });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });

// ---------- validation (same rules as server.js) ----------

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}
const mapIdFor = (place, room) => slug(place) + '--' + slug(room);
const validId = (id) => typeof id === 'string' && /^[a-z0-9-]{1,40}--[a-z0-9-]{1,40}$/.test(id);

function validateMap(map) {
  if (!map || typeof map !== 'object') return 'map must be a JSON object';
  if (map.map_version !== 1) return 'map_version must be 1';
  if (typeof map.location_name !== 'string' || !map.location_name.trim()) return 'location_name is required';
  if (typeof map.created_at !== 'string' || isNaN(Date.parse(map.created_at))) return 'created_at must be an ISO timestamp';
  if (!Array.isArray(map.waypoints) || map.waypoints.length === 0) return 'waypoints must be a non-empty array';
  for (let i = 0; i < map.waypoints.length; i++) {
    const w = map.waypoints[i];
    if (!w || typeof w !== 'object') return 'waypoint ' + i + ' must be an object';
    for (const k of ['id', 'label', 'notes', 'transition_from_previous', 'photo_base64']) {
      if (typeof w[k] !== 'string') return 'waypoint ' + i + ' is missing string field "' + k + '"';
    }
    if (w.order !== i + 1) return 'waypoint ' + i + ' has wrong order (expected ' + (i + 1) + ')';
    if (!w.photo_base64.startsWith('data:image/jpeg;base64,')) return 'waypoint ' + i + ' photo_base64 must be a JPEG data URL';
  }
  return null;
}

function validateWrapper(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (typeof body.place_name !== 'string' || !body.place_name.trim()) return 'place_name is required';
  if (typeof body.room_name !== 'string' || !body.room_name.trim()) return 'room_name is required';
  return validateMap(body.map);
}

// ---------- listing helper ----------
// Summary info is kept in blob metadata so listing never downloads photo payloads.

async function listSummaries() {
  const s = store();
  const { blobs } = await s.list();
  const metas = await Promise.all(
    blobs.map(async (b) => {
      try {
        const meta = await s.getMetadata(b.key);
        const m = meta && meta.metadata;
        if (!m || !m.place_name) return null;
        return {
          map_id: b.key,
          place_name: m.place_name,
          room_name: m.room_name,
          location_name: m.location_name,
          created_at: m.created_at,
          waypoint_count: m.waypoint_count
        };
      } catch (e) { return null; }
    })
  );
  return metas.filter(Boolean);
}

// ---------- handler ----------

export default async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    if (p === '/api/places' && req.method === 'GET') {
      const byPlace = new Map();
      for (const s of await listSummaries()) {
        if (!byPlace.has(s.place_name)) byPlace.set(s.place_name, []);
        byPlace.get(s.place_name).push({
          map_id: s.map_id, room_name: s.room_name,
          waypoint_count: s.waypoint_count, created_at: s.created_at
        });
      }
      return json(200, Array.from(byPlace.entries()).map(([place_name, rooms]) => ({
        place_name,
        rooms: rooms.sort((a, b) => a.room_name.localeCompare(b.room_name))
      })).sort((a, b) => a.place_name.localeCompare(b.place_name)));
    }

    if (p === '/api/maps' && req.method === 'GET') {
      const list = await listSummaries();
      return json(200, list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    }

    if (p === '/api/maps' && req.method === 'POST') {
      let wrapper;
      try { wrapper = await req.json(); } catch (e) { return json(400, { error: 'invalid JSON' }); }
      const problem = validateWrapper(wrapper);
      if (problem) return json(400, { error: problem });
      const id = mapIdFor(wrapper.place_name, wrapper.room_name);
      await store().setJSON(id, {
        place_name: wrapper.place_name.trim(),
        room_name: wrapper.room_name.trim(),
        map: wrapper.map
      }, {
        metadata: {
          place_name: wrapper.place_name.trim(),
          room_name: wrapper.room_name.trim(),
          location_name: wrapper.map.location_name,
          created_at: wrapper.map.created_at,
          waypoint_count: wrapper.map.waypoints.length
        }
      });
      return json(200, { map_id: id });
    }

    const single = p.match(/^\/api\/maps\/([^/]+)$/);
    if (single) {
      const id = single[1];
      if (!validId(id)) return json(400, { error: 'bad map id' });
      if (req.method === 'GET') {
        const wrapper = await store().get(id, { type: 'json' });
        if (!wrapper || !wrapper.map) return json(404, { error: 'map not found' });
        // Consumers get ONLY the v1 map body — the contract schema, untouched.
        return json(200, wrapper.map);
      }
      if (req.method === 'DELETE') {
        const existing = await store().getMetadata(id);
        if (!existing) return json(404, { error: 'map not found' });
        await store().delete(id);
        return json(200, { deleted: id });
      }
    }
  } catch (e) {
    return json(500, { error: e.message });
  }

  return json(404, { error: 'not found' });
};

export const config = { path: '/api/*' };
