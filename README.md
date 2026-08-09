# PathMapper

Caretaker-facing indoor mapping for a blind-navigation assistive device.

**Data model:** a **place** (house, office) contains **rooms**; inside each room the caretaker photographs every important **spot** (door, fridge, radio, water dispenser, toilet, switches…) with directions from the previous spot. Each room is stored as one map in the strict `map_version: 1` contract schema — the hierarchy lives *around* the map, never inside it, so consumer apps keep reading plain v1 maps.

## Two interchangeable backends, one API

| | File | Storage | Use for |
|---|---|---|---|
| **Netlify** (production) | `netlify/functions/api.mjs` | Netlify Blobs | The deployed site |
| **Local / self-hosted** | `server.js` | `./data` folder | Development, or any Node host |

Run locally with `node server.js` (Node 18+, no install needed) → http://localhost:3210.

On Netlify nothing extra is needed: `netlify.toml` publishes `public/` and wires the function; Blobs storage is automatic. **Storage on Netlify persists across deploys** (unlike a container's disk).

## API (for the consumer/navigation systems)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/places` | `[{ place_name, rooms: [{ map_id, room_name, waypoint_count, created_at }] }]` |
| GET | `/api/maps` | Flat list of room-map summaries |
| GET | `/api/maps/:map_id` | The room's full map — **exact v1 contract schema, no extra fields** |
| POST | `/api/maps` | Body `{ place_name, room_name, map }`. Upserts per place+room. Returns `{ map_id }` |
| DELETE | `/api/maps/:map_id` | Remove a room map |

- CORS is open (`*`).
- `map_id` is deterministic: `slug(place)--slug(room)` — re-saving a room after adding spots **overwrites** it, no duplicates.
- The map's `location_name` is `"<Place> — <Room>"` so v1-only consumers still see where a map belongs.

## Limits & caveats

- **Netlify function bodies are capped at 6 MB** — roughly 40+ spots per room at the app's photo size (1024 px, JPEG 0.7). Map large areas as several rooms/zones rather than one giant room.
- **No authentication yet** — anyone with the link can view and save maps. Add a shared-secret header check in both backends before real families use this.
- Photos are stored inline (base64) in the map JSON per the consumer contract.

## Deploying

The site is a Netlify project (`map-environment`) deployed from this repo. Push to the connected branch → Netlify builds and deploys automatically. The caretaker app and the API share one `https://…netlify.app` origin, so the live camera works and no CORS setup is needed.
