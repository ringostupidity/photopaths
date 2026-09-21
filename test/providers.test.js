import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers.js';

test('OSM lighting includes tagged ways as well as individual lamps', async () => {
  let query;
  const provider = createProviders({}, async (url, options) => {
    query = options.body.get('data');
    return {
      ok: true,
      json: async () => ({
        elements: [
          { type: 'node', id: 1, lat: 33.88, lon: -117.89 },
          {
            type: 'way',
            id: 2,
            tags: { lit: 'yes', name: 'Campus path' },
            geometry: [
              { lat: 33.88, lon: -117.89 },
              { lat: 33.881, lon: -117.89 },
            ],
          },
          {
            type: 'way',
            id: 3,
            tags: { lit: 'no' },
            geometry: [
              { lat: 33.88, lon: -117.89 },
              { lat: 33.882, lon: -117.89 },
            ],
          },
        ],
      }),
    };
  });
  const result = await provider.lamps(33.88, -117.89, 2000);
  assert.match(query, /way\[highway\]\[lit\]/);
  assert.equal(result.items.length, 1);
  assert.equal(result.ways.length, 2);
  assert.equal(result.ways[0].lit, 'yes');
  assert.deepEqual(result.ways[0].coordinates[0], [-117.89, 33.88]);
  assert.equal(result.ways[1].lit, 'no');
  assert.equal(result.ways[0].score, undefined);
});
test('Overpass partial timeout responses are not presented as no lighting data', async () => {
  const provider = createProviders({}, async () => ({
    ok: true,
    json: async () => ({ elements: [], remark: 'runtime error: Query timed out' }),
  }));
  await assert.rejects(provider.lamps(33.88, -117.89, 2000), (error) => error.status === 502);
});

test('walking fallback uses the foot-profile server and preserves route geometry', async () => {
  let requested;
  const providers = createProviders({}, async (url) => {
    requested = url;
    return {
      ok: true,
      json: async () => ({
        code: 'Ok',
        routes: [
          {
            distance: 200,
            duration: 150,
            geometry: {
              type: 'LineString',
              coordinates: [
                [1, 2],
                [1.001, 2],
              ],
            },
            legs: [{ steps: [{ name: 'Park walk', distance: 200, maneuver: { type: 'depart' } }] }],
          },
        ],
      }),
    };
  });
  const routes = await providers.routes(
    { latitude: 2, longitude: 1 },
    { latitude: 2, longitude: 1.001 },
  );
  assert.match(requested, /^https:\/\/routing.openstreetmap.de\/routed-foot\//);
  assert.equal(routes[0].duration_seconds, 150);
  assert.match(routes[0].steps[0].instruction, /Park walk/);
});
test('OpenRouteService uses foot-walking and keeps the API key on server requests', async () => {
  let requested;
  const providers = createProviders({ ORS_API_KEY: 'test-key' }, async (url, options) => {
    requested = { url, options };
    return {
      ok: true,
      json: async () => ({
        features: [
          {
            geometry: {
              type: 'LineString',
              coordinates: [
                [1, 2],
                [1.001, 2],
              ],
            },
            properties: {
              summary: { duration: 150, distance: 200 },
              segments: [{ steps: [{ instruction: 'Walk straight', distance: 200 }] }],
            },
          },
        ],
      }),
    };
  });
  await providers.routes({ latitude: 2, longitude: 1 }, { latitude: 2, longitude: 1.001 });
  assert.match(requested.url, /foot-walking\/geojson$/);
  assert.equal(requested.options.headers.Authorization, 'test-key');
});
test('search caches repeated queries and upstream errors are readable', async () => {
  let calls = 0;
  const providers = createProviders({}, async () => {
    calls++;
    return { ok: true, json: async () => [{ lat: '2', lon: '1', display_name: 'Test' }] };
  });
  await providers.geocode('Park');
  await providers.geocode('park');
  assert.equal(calls, 1);
  const unavailable = createProviders({}, async () => {
    throw new Error('Network details must not leak');
  });
  await assert.rejects(
    unavailable.geocode('Park'),
    (e) => e.status === 502 && !e.message.includes('Network details'),
  );
});
