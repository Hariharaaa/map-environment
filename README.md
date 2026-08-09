# PathMapper

Caretaker-facing indoor mapping for a blind-navigation assistive device.

**Data model:** a **place** (house, office) contains **rooms**; inside each room the caretaker photographs every important **spot** (door, fridge, radio, water dispenser, toilet, switches…) with directions from the previous spot. Each room is stored as one map in the strict `map_version: 1` contract schema — the hierarchy lives *around* the map, never inside it, so consumer apps keep reading plain v1 maps.

## Backends

| | File | Storage | Use for |
|---|---|---|---|
| **Vercel** (production) | `api/places.js`, `api/maps/index.js`, `api/maps/[id].js` | Vercel Blob | The deployed site |
| **Local / self-hosted** | `server.js` | `./data` folder | Development, or any Node host |

Install dependencies with `npm install`, then run locally with `npm start` (Node 18+) → http://localhost:3210.

On Vercel, create a Blob store for the project and set the environment variables from `.env.example`. The API stores the original v1 map body in Blob storage and keeps a small `pathmapper/index.json` summary file so list endpoints do not download every photo payload.

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

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | Yes on Vercel | Read/write token for the connected Vercel Blob store |
| `BLOB_ACCESS` | No | `private` by default; set to `public` only if the Blob store is public |
| `MAP_BODY_LIMIT_BYTES` | No | API-side JSON body guard. Defaults to `4194304` bytes |

## Limits & caveats

- **Vercel functions have a 4.5 MB request/response payload limit.** The app compresses photos before saving and refuses oversized room uploads instead of truncating data. Map large areas as several rooms/zones rather than one giant room.
- **No authentication yet** — anyone with the link can view and save maps. Add a shared-secret header check in both backends before real families use this.
- Photos are stored inline (base64) in the map JSON per the consumer contract.

## Deploying

Deploy this repo to Vercel with the default static + Serverless Functions setup. Vercel serves `public/index.html` as the frontend and routes `/api/*` to the files in `api/`. The caretaker app and the API share one origin, so the live camera works over HTTPS and no hard-coded localhost URL is needed.
