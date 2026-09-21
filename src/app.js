import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import SunCalc from 'suncalc';
import { HttpError, coordinates, number } from './errors.js';
import { distance, scoreRoute, rankRoutes } from './scoring.js';
import { imageScore } from '../public/lighting.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const kinds = new Set(['reports', 'measurements']);
const validId = (id) => /^[a-f0-9-]{36}$/.test(id);
function area(query) {
  const location = coordinates({
    lat: query.lat === undefined ? undefined : Number(query.lat),
    lon: query.lon === undefined ? undefined : Number(query.lon),
  });
  return {
    ...location,
    radius: number(query.radius === undefined ? 2000 : Number(query.radius), 100, 20000, 'Radius'),
  };
}
async function photo(value) {
  if (!value) return null;
  if (
    typeof value !== 'string' ||
    value.length > 280000 ||
    !/^data:image\/(jpeg|png|webp);base64,/.test(value)
  )
    throw new HttpError(400, 'Photo must be a JPEG, PNG, or WebP under 200 KB.');
  try {
    const buffer = Buffer.from(value.split(',')[1], 'base64');
    const clean = await sharp(buffer, { limitInputPixels: 16000000 })
      .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return `data:image/jpeg;base64,${clean.toString('base64')}`;
  } catch {
    throw new HttpError(400, 'This photo could not be read. Choose a different image.');
  }
}
export function createApp({ store, providers, secret, production = false, limits = true }) {
  if (!secret || secret.length < 32)
    throw new Error('SESSION_SECRET must have at least 32 characters.');
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org'],
          connectSrc: ["'self'"],
          mediaSrc: ["'self'", 'blob:'],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: '350kb' }));
  app.use(cookieParser(secret));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      // A custom header prevents cross-site forms from submitting anonymous contributions.
      if (req.get('X-Photopath') !== '1' || req.get('Sec-Fetch-Site') === 'cross-site')
        return next(new HttpError(403, 'Please submit from the Photopath app.'));
    }
    let identity = req.signedCookies.photopath;
    if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) {
      identity = randomBytes(32).toString('hex');
      res.cookie('photopath', identity, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        secure: production,
        maxAge: 365 * 86400000,
        path: '/',
      });
    }
    req.owner = createHash('sha256').update(identity).digest('hex');
    next();
  });
  if (limits) {
    app.use(
      '/api',
      rateLimit({
        windowMs: 60000,
        limit: 90,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many requests. Please wait a minute.' },
      }),
    );
    const writes = rateLimit({
      windowMs: 60000,
      limit: 12,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Please wait a minute before contributing again.' },
    });
    app.use('/api', (req, res, next) =>
      ['POST', 'DELETE'].includes(req.method) && !['/route', '/geocode'].includes(req.path)
        ? writes(req, res, next)
        : next(),
    );
  }
  app.get('/api/test', (req, res) => res.json({ message: 'Express is working!' }));
  app.get('/api/session', (req, res) => res.json({ ready: true }));
  app.get('/api/health', async (req, res) => {
    await store.ping();
    res.json({ status: 'ok', database: 'Upstash Redis' });
  });
  app.post('/api/geocode', async (req, res) => {
    const query = req.body?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 200)
      throw new HttpError(400, 'Enter a place name of up to 200 characters.');
    const results = await providers.geocode(query.trim());
    if (!results.length)
      throw new HttpError(404, 'Destination not found. Try a more specific address.');
    res.json({ ...results[0], results });
  });
  app.get('/api/nearby', async (req, res) => {
    const { latitude, longitude, radius } = area(req.query);
    const [measurements, reports] = await Promise.all(
      kindsToNearby(store, latitude, longitude, radius),
    );
    res.json({
      measurements: measurements.items,
      reports: reports.items,
      truncated: measurements.truncated || reports.truncated,
    });
  });
  app.get('/api/streetlights', async (req, res) => {
    const { latitude, longitude, radius } = area(req.query);
    if (radius > 2000) throw new HttpError(400, 'Streetlight search is limited to 2 km.');
    res.json(await providers.lamps(latitude, longitude, radius));
  });
  app.post('/api/measurements', async (req, res) => {
    const b = req.body ?? {},
      location = coordinates(b);
    const brightness = number(b.brightness, 0, 100, 'Brightness'),
      dark_fraction = number(b.dark_fraction, 0, 1, 'Dark fraction');
    const contrast = number(b.contrast, 0, 50.01, 'Contrast');
    if (b.consent !== true)
      throw new HttpError(400, 'Confirm that you want to share this measurement.');
    const now = new Date();
    const record = {
      id: randomUUID(),
      owner: req.owner,
      ...location,
      timestamp: now.toISOString(),
      brightness,
      dark_fraction,
      contrast,
      score: imageScore(brightness, dark_fraction),
      is_night:
        SunCalc.getPosition(now, location.latitude, location.longitude).altitude <
        (-6 * Math.PI) / 180,
    };
    res.status(201).json({ data: await store.save('measurements', record) });
  });
  app.post('/api/reports', async (req, res) => {
    const b = req.body ?? {},
      location = coordinates(b);
    if (!['broken', 'broken_light', 'flickering', 'dim', 'off', 'other'].includes(b.report_type))
      throw new HttpError(400, 'Choose a valid lighting problem.');
    if (b.description != null && (typeof b.description !== 'string' || b.description.length > 1000))
      throw new HttpError(400, 'Description must be at most 1,000 characters.');
    if (b.consent !== true) throw new HttpError(400, 'Confirm that you want to share this report.');
    const record = {
      id: randomUUID(),
      owner: req.owner,
      ...location,
      report_type: b.report_type === 'broken_light' ? 'broken' : b.report_type,
      description: b.description?.trim() || '',
      photo: await photo(b.photo),
      timestamp: new Date().toISOString(),
      status: 'unverified',
      confirmations: 0,
      repair_votes: 0,
    };
    res.status(201).json({ message: 'Report saved!', data: await store.save('reports', record) });
  });
  app.post('/api/reports/:id/verify', async (req, res) => {
    if (!validId(req.params.id) || !['confirm', 'repaired'].includes(req.body?.action))
      throw new HttpError(400, 'Choose a valid report and review.');
    res.json({ data: await store.vote(req.params.id, req.owner, req.body.action) });
  });
  app.get('/api/contributions', async (req, res) =>
    res.json({ items: await store.mine(req.owner) }),
  );
  app.delete('/api/:kind/:id', async (req, res) => {
    if (!kinds.has(req.params.kind) || !validId(req.params.id))
      throw new HttpError(404, 'Contribution not found.');
    await store.remove(req.params.kind, req.params.id, req.owner);
    res.status(204).end();
  });
  app.post('/api/route', async (req, res) => {
    const start = coordinates(req.body?.start),
      end = coordinates(req.body?.end);
    const separation = distance(start, end);
    if (separation < 20 || separation > 15000)
      throw new HttpError(400, 'Choose locations between 20 metres and 15 km apart.');
    const preference = number(req.body?.preference ?? 0.5, 0, 1, 'Route preference');
    const raw = await providers.routes(start, end);
    if (
      raw.some(
        (r) =>
          r.distance > 30000 ||
          r.geometry?.type !== 'LineString' ||
          r.geometry.coordinates.length > 15000,
      )
    )
      throw new HttpError(400, 'Walking route is too long for this local-area prototype.');
    // Load one shared area covering every alternative, independently of the map overlay.
    const points = raw.flatMap((r) => r.geometry.coordinates);
    const lats = points.map((p) => p[1]),
      lons = points.map((p) => p[0]);
    const center = {
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
    };
    const radius =
      Math.max(...points.map((p) => distance(center, { latitude: p[1], longitude: p[0] }))) + 100;
    const results = await Promise.allSettled([
      ...kindsToNearby(store, center.latitude, center.longitude, radius),
      providers.lamps(center.latitude, center.longitude, radius, 2000),
    ]);
    const warnings = [];
    const data = results.map((result, i) => {
      if (result.status === 'fulfilled') {
        if (result.value.truncated)
          warnings.push('Lighting results reached the data limit; coverage may be incomplete.');
        return result.value;
      }
      if (![502, 503, 429].includes(result.reason.status)) throw result.reason;
      warnings.push(
        i === 2
          ? 'OSM lighting is unavailable; only available camera readings are used.'
          : 'Some community lighting data is unavailable; OSM estimates can still be used.',
      );
      return { items: [], ways: [] };
    });
    const routes = raw.map((r) => scoreRoute(r, data[0].items, data[1].items, Date.now(), data[2]));
    const warning = [...new Set(warnings)].join(' ') || null;
    res.json({ routes: rankRoutes(routes, preference), warning, mode: 'walking' });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use('/vendor/leaflet', express.static(`${root}node_modules/leaflet/dist`));
  for (const page of ['map', 'report', 'measure', 'settings'])
    app.get(`/${page}`, (req, res) => res.sendFile(`${root}public/${page}.html`));
  app.use(express.static(`${root}public`));
  app.use((req, res) => res.status(404).sendFile(`${root}public/404.html`));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status =
      err.type === 'entity.too.large'
        ? 413
        : err instanceof SyntaxError && err.status === 400
          ? 400
          : err.status || 500;
    const message =
      err.type === 'entity.too.large'
        ? 'This upload is too large.'
        : err instanceof SyntaxError
          ? 'Invalid JSON request.'
          : status < 500 || err instanceof HttpError
            ? err.message
            : 'Something went wrong. Please try again.';
    res.status(status).json({ error: message });
  });
  return app;
}
function kindsToNearby(store, lat, lon, radius) {
  return ['measurements', 'reports'].map((kind) => store.nearby(kind, lat, lon, radius));
}
