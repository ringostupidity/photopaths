# Photopath

A complete browser prototype for nighttime walking routes, camera lighting estimates, and community streetlight reports. Built with **Node.js + Express 5**, Leaflet, and **Upstash Redis over TLS**. The visual design follows the original Photopath pages.

## Run locally

Requires Node.js 22 or newer. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

```powershell
npm.cmd install
# For a fresh checkout only:
Copy-Item .env.example .env
# Fill in UPSTASH_REDIS_URL and SESSION_SECRET in .env.
npm.cmd start
```

Open **http://localhost:5000**. The current workspace already has a configured, ignored `.env`; do not overwrite it with the example. `npm.cmd run dev` restarts the server when files change.

Generate a session secret for another environment:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The Upstash URL must start with `rediss://`. This app uses the Redis protocol on port 6379, not Upstash REST credentials. Database credentials never go to the browser. No SQL migrations or table setup are needed. All Redis keys are namespaced under `photopath:v1`.

## Included flows

- **Home:** original branding, responsive cards, illustrative route comparison, and navigation.
- **Map:** place search with selectable matches, GPS, explicit start/destination map pickers, draggable endpoint pins, actual walking routes and alternatives when the provider returns them, directions, route selection, and a fastest-to-brightest preference slider.
- **Lighting layers:** recent nighttime camera readings, reports, and OSM streetlight locations plus roads/paths tagged `lit` within 2 km of the map center. Use **Load OSM lighting** to load that separate layer. Refresh the area after panning. Mapped streetlights do not imply that a light works.
- **Measure:** opt-in camera access, local frame analysis, GPS at capture time, review before sharing, and nighttime classification. Measurements upload metrics and coordinates only, never the captured image. Camera tracks stop after capture, when the page is hidden, or when closed.
- **Report:** broken, flickering, dim, off, or other problems; GPS, map, or typed coordinates; description; optional resized photo with metadata stripped; explicit consent; real persistence.
- **Community review:** confirm a problem or report a repair from its map popup. Two confirmations mark a report corroborated; two repair votes mark it community resolved. One vote per anonymous browser, excluding the author. This is not identity verification or official city status.
- **My activity:** favorite destinations, distance units, default routing preference, own contributions, and deletion. A signed, HTTP-only cookie controls ownership; favorites and preferences are stored locally. Clearing cookies loses access to previously submitted contributions.

## How lighting scores work

Image luminance is `0.2126 × red + 0.7152 × green + 0.0722 × blue`, normalized to 0–100. Pixels below 15% luminance count as very dark. The experimental score is:

```text
score = round(0.7 × brightness + 30 × (1 − dark_fraction))
```

It is **not lux**. Auto-exposure, the phone, weather, and framing affect results. The server recalculates the submitted score and uses solar position at submission to classify night (sun below −6°). Daytime readings are saved in My activity but excluded from nighttime map and route scores. Capture and share within two minutes.

Routes are sampled at intervals no longer than 50 m. Each section uses nighttime measurements within 60 m and under 30 days old, weighted with a seven-day half-life. Recent corroborated reports within 60 m subtract ten points each, capped at twenty. Reports alone never create a measured visibility score. Resolved reports have no effect.

Where camera data is missing, route calculation automatically loads OSM lighting across all returned alternatives, regardless of whether the map overlay has been loaded. It matches nearby, similarly aligned road/path segments (within 20 m), using experimental infrastructure priors: `lit=yes` or `24/7` = 70, `lit=no` = 20, `limited` = 50, and `automatic` = 60. Other tag values stay unknown. If there is no matching tagged way, a mapped lamp within 35 m gives an estimate of 60. An explicit matching way tag takes priority over lamp proximity. These numbers are heuristic estimates, not measured brightness or calibrated predictions. Camera readings always take priority. Corroborated report penalties also apply to OSM estimates.

The route score is a length-weighted average over covered sections. An overall score requires at least **60% lighting coverage**, combining camera readings and OSM estimates. Cards separately report camera and OSM coverage, and OSM-based scores are labeled `est.`. Dashed colored route sections indicate OSM estimates; solid sections use camera readings. Partial coverage retains a covered-section score, while sections with no evidence remain unknown. The API returns `covered_score` for the combined average and reserves `measured_score` for actual camera readings.

The route preference combines normalized walking time with darkness and uncertainty:

```text
darkness = coverage × (1 − covered_score / 100) + (1 − coverage)
cost = (1 − preference) × (duration / fastest_duration) + preference × darkness
```

Unknown routes use darkness/uncertainty cost 1. This ranks the provider's returned alternatives rather than generating a new road-network route. “Highest lighting estimate” means the highest score among returned routes with at least 60% coverage. If neither measurements nor usable OSM evidence exists, routes fall back to travel time. OSM failures do not discard camera data, and database failures do not discard OSM estimates. The response reports unavailable or truncated data.

## Services and limits

- Search: [Nominatim](https://operations.osmfoundation.org/policies/nominatim/), explicit searches only, cached for 24 hours, throttled to below one upstream request per second.
- Default walking routing: [FOSSGIS OSRM foot server](https://routing.openstreetmap.de/about.html). Its endpoint contains `/driving` because of the OSRM URL convention, but the selected server uses the **foot routing profile**. Never substitute a driving-profile server for pedestrian routes. Route requests are throttled and cached for five minutes.
- Optional routing: set `ORS_API_KEY` for [OpenRouteService foot-walking](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/) with alternative routes.
- Streetlights: Overpass `highway=street_lamp` nodes and `highway` ways with `lit` tags, one-hour cache. The on-demand map layer covers a 2 km radius and up to 500 objects per type; route scoring covers the full route area and up to 2,000 objects per type so dense areas are not constrained by the display limit. Partial Overpass error responses are reported as failures instead of empty results. These are external infrastructure data, not measured brightness.
- Tiles: OpenStreetMap, with attribution. Place searches and route endpoints are shared with their respective providers; tile requests and lamp queries also go to external map services.
- Storage: Upstash Redis hashes for records, geospatial sorted sets for nearby lookup, owner sets, and per-report voter sets. Report verification and deletion are atomic Lua operations. There is no in-memory persistence fallback in the running app.

This local-area prototype limits endpoint separation to 15 km and returned walks to 30 km. Nearby queries return the nearest 500 records per layer and disclose truncation. Data is retained until its owner deletes it; scoring ignores readings/reports older than 30 days. Streetlight datasets from individual cities are not imported automatically.

For deployment, use HTTPS (required for camera/GPS and secure production cookies), keep `SESSION_SECRET` stable, set `NODE_ENV=production`, and set `HOST=0.0.0.0` when your hosting platform requires it. Set `APP_USER_AGENT` to identify your deployment and provide a contact URL. Configure a precise Express proxy trust policy for your own reverse proxy before relying on per-client IP limits.

Provider throttling/caching and request rate limits are in-process: run a single worker with the public demo services. For multiple instances or significant traffic, use a shared rate limiter/cache and appropriately provisioned map/routing services. Anonymous browser voting is suitable for a prototype; it does not prevent a determined user from changing identity. Add authenticated moderation before relying on reports at public scale.

## API

All writes require JSON and the `X-Photopath: 1` header. Session cookies are issued by `GET /api/session`. Coordinates are finite JSON numbers. Latitude is limited to −85…85 by Redis geospatial indexing.

| Endpoint                                        | Purpose                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/test`                                 | Express liveness                                                           |
| `GET /api/health`                               | Upstash connectivity                                                       |
| `POST /api/geocode`                             | `{ query }`, returns matches                                               |
| `POST /api/route`                               | `{ start: {lat, lon}, end: {lat, lon}, preference: 0…1 }`                  |
| `GET /api/nearby?lat=…&lon=…&radius=2000`       | Measurements and reports                                                   |
| `GET /api/streetlights?lat=…&lon=…&radius=2000` | OSM lamps and lighting-tagged ways                                         |
| `POST /api/measurements`                        | `{latitude, longitude, brightness, dark_fraction, contrast, consent:true}` |
| `POST /api/reports`                             | `{latitude, longitude, report_type, description?, photo?, consent:true}`   |
| `POST /api/reports/:id/verify`                  | `{action:"confirm"}` or `{action:"repaired"}`                              |
| `GET /api/contributions`                        | Current browser's contributions                                            |
| `DELETE /api/:kind/:id`                         | Own report or measurement; kind is `reports` or `measurements`             |

The Python prototype and original `templates/` are preserved as reference files, including existing local Python edits. The Node app serves only `public/`; it does not run Python or use Supabase. The old mutating `GET /test-report` is replaced by the report form and `POST /api/reports`.

## Validation

```powershell
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:browser
npm.cmd run format:check
```

Unit/API tests cover validation, ownership, photos, review rules, scoring, provider integration contracts, and outage behavior. Browser tests use isolated fixture services and cover responsive pages, search/routes, favorites, report submission/deletion, camera capture, and failure states. Browser tests do not write into the real Upstash database. Physical-device camera calibration and location accuracy still need field testing.
