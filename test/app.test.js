import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { MemoryStore, fixtureProviders } from './helpers.js';
import { HttpError } from '../src/errors.js';

const secret = 'test-secret-'.repeat(4);
function setup() {
  const store = new MemoryStore();
  return { store, app: createApp({ store, providers: fixtureProviders, secret, limits: false }) };
}
const report = {
  latitude: 33.91,
  longitude: -117.89,
  report_type: 'broken',
  description: 'A dark corner',
  consent: true,
};
const post = (agent, path, body) => agent.post(path).set('X-Photopath', '1').send(body);

test('serves all pages and static assets with restrictive headers', async () => {
  const { app } = setup();
  for (const path of [
    '/',
    '/map',
    '/report',
    '/measure',
    '/settings',
    '/map.html',
    '/style.css',
    '/vendor/leaflet/leaflet.js',
  ])
    await request(app).get(path).expect(200);
  const response = await request(app).get('/');
  assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  await request(app).get('/does-not-exist').expect(404);
  await request(app).get('/.env').expect(404);
  await request(app).get('/api/missing').expect(404);
});
test('reports persist, remain public without owner credentials, and can only be deleted by creator', async () => {
  const { app } = setup(),
    creator = request.agent(app),
    other = request.agent(app);
  const saved = await post(creator, '/api/reports', report).expect(201);
  assert.equal(saved.body.data.owner, undefined);
  const id = saved.body.data.id;
  const nearby = await other.get('/api/nearby?lat=33.91&lon=-117.89').expect(200);
  assert.equal(nearby.body.reports[0].id, id);
  const mine = await creator.get('/api/contributions').expect(200);
  assert.equal(mine.body.items.length, 1);
  assert.equal((await other.get('/api/contributions')).body.items.length, 0);
  await other.delete(`/api/reports/${id}`).set('X-Photopath', '1').expect(403);
  await creator.delete(`/api/reports/${id}`).set('X-Photopath', '1').expect(204);
  assert.equal((await creator.get('/api/contributions')).body.items.length, 0);
});
test('validates coordinate types, consent, report types, descriptions, and malformed JSON', async () => {
  const { app } = setup(),
    agent = request.agent(app);
  for (const changes of [
    { latitude: '33.91' },
    { latitude: 90 },
    { longitude: null },
    { report_type: 'invalid' },
    { description: 'a'.repeat(1001) },
    { consent: false },
    { latitude: NaN },
  ])
    await post(agent, '/api/reports', { ...report, ...changes }).expect(400);
  await post(agent, '/api/reports', null).expect(400);
  await agent.post('/api/reports').send(report).expect(403);
  await agent
    .post('/api/reports')
    .set('X-Photopath', '1')
    .set('Sec-Fetch-Site', 'cross-site')
    .send(report)
    .expect(403);
  await agent
    .post('/api/reports')
    .set('Content-Type', 'application/json')
    .set('X-Photopath', '1')
    .send('{broken')
    .expect(400);
  await agent.get('/api/nearby').expect(400);
});
test('report photos are decoded and normalized instead of storing arbitrary payloads', async () => {
  const { app } = setup(),
    agent = request.agent(app);
  await post(agent, '/api/reports', {
    ...report,
    photo: 'data:image/jpeg;base64,not-a-photo',
  }).expect(400);
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#444' } })
    .png()
    .toBuffer();
  const response = await post(agent, '/api/reports', {
    ...report,
    photo: `data:image/png;base64,${buffer.toString('base64')}`,
  }).expect(201);
  assert.match(response.body.data.photo, /^data:image\/jpeg;base64,/);
});
test('community verification rejects self and duplicate votes and resolves after two repair votes', async () => {
  const { app } = setup(),
    creator = request.agent(app);
  const { body } = await post(creator, '/api/reports', report),
    url = `/api/reports/${body.data.id}/verify`;
  await post(creator, url, { action: 'confirm' }).expect(400);
  const other = request.agent(app);
  await post(other, url, { action: 'confirm' }).expect(200);
  await post(other, url, { action: 'confirm' }).expect(409);
  const confirmed = await post(request.agent(app), url, { action: 'confirm' });
  assert.equal(confirmed.body.data.status, 'corroborated');
  await post(request.agent(app), url, { action: 'repaired' });
  const resolved = await post(request.agent(app), url, { action: 'repaired' });
  assert.equal(resolved.body.data.status, 'community_resolved');
});
test('measurement score is calculated server-side and requires consent', async () => {
  const { app } = setup(),
    agent = request.agent(app);
  const measurement = {
    latitude: 33.91,
    longitude: -117.89,
    brightness: 50,
    dark_fraction: 0.5,
    contrast: 20,
    score: 100,
    consent: true,
  };
  const response = await post(agent, '/api/measurements', measurement).expect(201);
  assert.equal(response.body.data.score, 50);
  assert.equal(typeof response.body.data.is_night, 'boolean');
  await post(agent, '/api/measurements', { ...measurement, dark_fraction: 2 }).expect(400);
  await post(agent, '/api/measurements', { ...measurement, consent: false }).expect(400);
});
test('search, route validation, missing coverage, and database outage responses', async () => {
  const { app, store } = setup(),
    agent = request.agent(app);
  await post(agent, '/api/geocode', { query: ' ' }).expect(400);
  await post(agent, '/api/geocode', { query: 'missing' }).expect(404);
  const places = await post(agent, '/api/geocode', { query: 'Park' }).expect(200);
  assert.equal(places.body.results.length, 1);
  const points = { start: { lat: 33.91, lon: -117.89 }, end: { lat: 33.911, lon: -117.89 } };
  const routes = await post(agent, '/api/route', points).expect(200);
  assert.equal(routes.body.mode, 'walking');
  assert.equal(routes.body.routes[0].score, 70);
  assert.equal(routes.body.routes[0].source, 'osm');
  assert.equal(routes.body.routes[0].measured_coverage, 0);
  await post(agent, '/api/route', { ...points, preference: 2 }).expect(400);
  await post(agent, '/api/route', { start: points.start, end: points.start }).expect(400);
  await post(agent, '/api/route', { ...points, end: { lat: 50, lon: 20 } }).expect(400);
  store.nearby = async () => {
    throw new HttpError(503, 'Database unavailable.');
  };
  const degraded = await post(agent, '/api/route', points).expect(200);
  assert.match(degraded.body.warning, /unavailable/);
  assert.equal(degraded.body.routes[0].score, 70);
  await agent.get('/api/nearby?lat=33.91&lon=-117.89').expect(503);
});

test('OSM outage still returns camera-only or unknown routes without fabricated estimates', async () => {
  const app = createApp({
    store: new MemoryStore(),
    providers: {
      ...fixtureProviders,
      lamps: async () => {
        throw new HttpError(502, 'OSM unavailable');
      },
    },
    secret,
    limits: false,
  });
  const result = await post(request.agent(app), '/api/route', {
    start: { lat: 33.91, lon: -117.89 },
    end: { lat: 33.911, lon: -117.89 },
  }).expect(200);
  assert.match(result.body.warning, /OSM lighting is unavailable/);
  assert.equal(result.body.routes[0].score, null);
  assert.equal(result.body.routes[0].osm_coverage, 0);
});
