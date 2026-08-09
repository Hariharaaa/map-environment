// PathMapper server (local / self-hosted variant) — serves the caretaker app
// and stores room maps on disk. The Netlify deployment uses the same API via
// netlify/functions/api.mjs + Netlify Blobs; keep the two in sync.
//
// Data model: a PLACE (house/office) contains ROOMS; each room is stored as
// one map in the exact map_version-1 contract schema. Hierarchy lives in a
// wrapper { place_name, room_name, map } — the map body itself never gains
// extra fields, so the consumer apps keep reading plain v1 maps.
//
// API:
//   GET    /api/places        -> [{ place_name, rooms: [{ map_id, room_name, waypoint_count, created_at }] }]
//   GET    /api/maps          -> flat list [{ map_id, place_name, room_name, location_name, created_at, waypoint_count }]
//   GET    /api/maps/:id      -> the room's map JSON (exact v1 schema, nothing else)
//   POST   /api/maps          -> body { place_name, room_name, map }; upserts per place+room, returns { map_id }
//   DELETE /api/maps/:id      -> removes a room map
//
// Run with `node server.js` (Node 18+, zero dependencies).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3210;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 60 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- shared logic (mirrored in netlify/functions/api.mjs) ----------

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
}

function mapIdFor(placeName, roomName) {
  // Deterministic per place+room, so re-saving a room overwrites it.
  return slug(placeName) + '--' + slug(roomName);
}

function validId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,40}--[a-z0-9-]{1,40}$/.test(id);
}

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

// ---------- storage ----------

function readAllWrappers() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const w = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (!w || !w.map) return null;
        return { map_id: f.slice(0, -5), wrapper: w };
      } catch (e) { return null; }
    })
    .filter(Boolean);
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

// ---------- http plumbing ----------

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      cb(new Error('body too large'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!aborted) cb(null, Buffer.concat(chunks).toString('utf8')); });
  req.on('error', (e) => { if (!aborted) cb(e); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400'
    });
    res.end();
    return;
  }

  try {
    if (p === '/api/places' && req.method === 'GET') {
      const byPlace = new Map();
      for (const entry of readAllWrappers()) {
        const s = summarize(entry);
        if (!byPlace.has(s.place_name)) byPlace.set(s.place_name, []);
        byPlace.get(s.place_name).push({
          map_id: s.map_id, room_name: s.room_name,
          waypoint_count: s.waypoint_count, created_at: s.created_at
        });
      }
      const out = Array.from(byPlace.entries()).map(([place_name, rooms]) => ({
        place_name,
        rooms: rooms.sort((a, b) => a.room_name.localeCompare(b.room_name))
      })).sort((a, b) => a.place_name.localeCompare(b.place_name));
      sendJson(res, 200, out);
      return;
    }

    if (p === '/api/maps' && req.method === 'GET') {
      sendJson(res, 200, readAllWrappers().map(summarize)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
      return;
    }

    if (p === '/api/maps' && req.method === 'POST') {
      readBody(req, (err, body) => {
        if (err) { sendJson(res, 413, { error: err.message }); return; }
        let wrapper;
        try { wrapper = JSON.parse(body); } catch (e) { sendJson(res, 400, { error: 'invalid JSON' }); return; }
        const problem = validateWrapper(wrapper);
        if (problem) { sendJson(res, 400, { error: problem }); return; }
        const id = mapIdFor(wrapper.place_name, wrapper.room_name);
        try {
          const tmp = path.join(DATA_DIR, id + '.tmp');
          fs.writeFileSync(tmp, JSON.stringify({
            place_name: wrapper.place_name.trim(),
            room_name: wrapper.room_name.trim(),
            map: wrapper.map
          }));
          fs.renameSync(tmp, path.join(DATA_DIR, id + '.json'));
          sendJson(res, 200, { map_id: id });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
      });
      return;
    }

    const single = p.match(/^\/api\/maps\/([^/]+)$/);
    if (single) {
      const id = single[1];
      if (!validId(id)) { sendJson(res, 400, { error: 'bad map id' }); return; }
      const file = path.join(DATA_DIR, id + '.json');
      if (req.method === 'GET') {
        fs.readFile(file, 'utf8', (err, data) => {
          if (err) { sendJson(res, 404, { error: 'map not found' }); return; }
          try {
            // Consumers get ONLY the v1 map body — the contract schema, untouched.
            sendJson(res, 200, JSON.parse(data).map);
          } catch (e) { sendJson(res, 500, { error: 'corrupt map file' }); }
        });
        return;
      }
      if (req.method === 'DELETE') {
        fs.unlink(file, (err) => {
          if (err) { sendJson(res, 404, { error: 'map not found' }); return; }
          sendJson(res, 200, { deleted: id });
        });
        return;
      }
    }
  } catch (e) {
    sendJson(res, 500, { error: e.message });
    return;
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('app file missing'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log('PathMapper server running on http://localhost:' + PORT);
  console.log('Storing maps in ' + DATA_DIR);
});
