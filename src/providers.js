import { HttpError } from './errors.js';

// Serialize public-service calls and cache responses. One instance by default;
// use a shared gateway or your own providers when scaling to multiple workers.
function providerGate() {
  let next = 0,
    pending = 0;
  return async (task) => {
    if (pending >= 8) throw new HttpError(429, 'Search is busy. Please try again shortly.');
    pending++;
    const wait = Math.max(0, next - Date.now());
    next = Date.now() + wait + 1100;
    try {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      return await task();
    } finally {
      pending--;
    }
  };
}
export function createProviders(env = process.env, fetcher = fetch) {
  const geocodeGate = providerGate(),
    routeGate = providerGate(),
    lampsGate = providerGate();
  const cache = new Map();
  async function cached(key, ttl, task) {
    const old = cache.get(key);
    if (old && old.expires > Date.now()) return old.value;
    const value = await task();
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + ttl });
    return value;
  }
  async function json(url, options = {}) {
    try {
      const response = await fetcher(url, {
        ...options,
        headers: { 'User-Agent': env.APP_USER_AGENT || 'Photopath/1.0', ...options.headers },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error('Upstream failure');
      return await response.json();
    } catch {
      throw new HttpError(502, 'The map service is unavailable. Please try again shortly.');
    }
  }
  return {
    async geocode(query) {
      return cached(`search:${query.toLowerCase()}`, 86400000, () =>
        geocodeGate(async () => {
          const url = new URL(env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search');
          url.search = new URLSearchParams({ q: query, format: 'json', limit: '5' });
          const data = await json(url);
          if (!Array.isArray(data))
            throw new HttpError(502, 'The search service returned invalid data.');
          return data.map((p) => ({
            lat: Number(p.lat),
            lon: Number(p.lon),
            name: p.display_name,
          }));
        }),
      );
    },
    async routes(start, end) {
      const coords = [
        [start.longitude, start.latitude],
        [end.longitude, end.latitude],
      ];
      return cached(`route:${JSON.stringify(coords)}`, 300000, () =>
        routeGate(async () => {
          if (env.ORS_API_KEY) {
            const data = await json(
              'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
              {
                method: 'POST',
                headers: { Authorization: env.ORS_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  coordinates: coords,
                  alternative_routes: { target_count: 3 },
                  instructions: true,
                }),
              },
            );
            if (!data.features?.length) throw new HttpError(404, 'No walking route found.');
            return data.features.map((f, i) => ({
              id: `route-${i}`,
              geometry: f.geometry,
              distance: f.properties.summary.distance,
              duration_seconds: f.properties.summary.duration,
              duration: Math.round(f.properties.summary.duration / 60),
              steps: f.properties.segments.flatMap((s) =>
                s.steps.map((t) => ({ instruction: t.instruction, distance: t.distance })),
              ),
            }));
          }
          // This server is built with a FOOT profile; OSRM's URL profile is named driving.
          const base =
            env.WALKING_ROUTER_URL ||
            'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
          const data = await json(
            `${base}/${coords.map((c) => c.join(',')).join(';')}?overview=full&geometries=geojson&alternatives=true&steps=true`,
          );
          if (data.code !== 'Ok' || !data.routes?.length)
            throw new HttpError(404, 'No walking route found. Try a nearby street.');
          return data.routes.map((r, i) => ({
            id: `route-${i}`,
            geometry: r.geometry,
            distance: r.distance,
            duration_seconds: r.duration,
            duration: Math.round(r.duration / 60),
            steps: r.legs.flatMap((l) =>
              l.steps.map((s) => ({
                instruction: `${s.maneuver.type.replaceAll('_', ' ')}${s.maneuver.modifier ? ` ${s.maneuver.modifier}` : ''}${s.name ? ` on ${s.name}` : ''}`,
                distance: s.distance,
              })),
            ),
          }));
        }),
      );
    },
    async lamps(lat, lon, radius, limit = 500) {
      return cached(`lamps:${lat.toFixed(3)}:${lon.toFixed(3)}:${radius}:${limit}`, 3600000, () =>
        lampsGate(async () => {
          const query = `[out:json][timeout:15];node[highway=street_lamp](around:${radius},${lat},${lon})->.lamps;way[highway][lit](around:${radius},${lat},${lon})->.ways;.lamps out body ${limit + 1};.ways out geom ${limit + 1};`;
          const data = await json('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ data: query }),
          });
          if (!Array.isArray(data.elements) || data.remark)
            throw new HttpError(502, 'Streetlight data is unavailable.');
          const lamps = data.elements.filter((e) => e.type === 'node');
          const ways = data.elements.filter((e) => e.type === 'way');
          return {
            items: lamps.slice(0, limit).map((n) => ({
              id: n.id,
              latitude: n.lat,
              longitude: n.lon,
              source: 'OpenStreetMap',
              status: 'Mapped infrastructure; operating status unknown',
            })),
            ways: ways
              .slice(0, limit)
              .filter((w) => w.geometry?.length >= 2)
              .map((w) => ({
                id: w.id,
                name: w.tags.name || '',
                lit: w.tags.lit,
                coordinates: w.geometry.map((p) => [p.lon, p.lat]),
              })),
            truncated: lamps.length > limit || ways.length > limit,
          };
        }),
      );
    },
  };
}
