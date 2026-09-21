import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels } from '../public/lighting.js';
import { scoreRoute, rankRoutes } from '../src/scoring.js';
import { osmEstimator } from '../src/osm-estimates.js';
const now = Date.parse('2026-09-20T06:00:00Z');
test('OSM tagged ways provide fallback estimates and camera readings override them', () => {
  const osm = {
    ways: [
      {
        lit: 'yes',
        coordinates: [
          [0, 0],
          [0.002, 0],
        ],
      },
    ],
  };
  const estimated = scoreRoute(route, [], [], now, osm);
  assert.equal(estimated.score, 70);
  assert.equal(estimated.source, 'osm');
  assert.equal(estimated.measured_score, null);
  assert.equal(estimated.measured_coverage, 0);
  assert.equal(estimated.osm_coverage, 100);
  assert.ok(estimated.sections.every((s) => s.source === 'osm_way'));
  const readings = [m('1', 0, 30), m('2', 0.001, 30), m('3', 0.002, 30)];
  const measured = scoreRoute(route, readings, [], now, osm);
  assert.equal(measured.score, 30);
  assert.equal(measured.source, 'camera');
  assert.equal(measured.osm_coverage, 0);
  const mixed = scoreRoute(route, [m('1', 0, 30)], [], now, osm);
  assert.equal(mixed.source, 'mixed');
  assert.ok(mixed.measured_coverage > 0 && mixed.osm_coverage > 0);
  assert.equal(mixed.coverage, 100);
});
test('OSM matching uses aligned nearby segments, explicit unlit tags, and lamp proximity', () => {
  const a = { latitude: 0, longitude: 0 },
    b = { latitude: 0, longitude: 0.002 };
  const point = { latitude: 0, longitude: 0.001 };
  assert.equal(
    osmEstimator({
      ways: [
        {
          lit: 'yes',
          coordinates: [
            [0.001, -0.002],
            [0.001, 0.002],
          ],
        },
      ],
    })(point, a, b),
    null,
  );
  assert.equal(
    osmEstimator({
      ways: [
        {
          lit: 'yes',
          coordinates: [
            [0, 0.001],
            [0.002, 0.001],
          ],
        },
      ],
    })(point, a, b),
    null,
  );
  assert.equal(
    osmEstimator({
      ways: [
        {
          lit: 'unknown',
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
        },
      ],
    })(point, a, b),
    null,
  );
  const lamp = { latitude: 0, longitude: 0.001 };
  assert.equal(osmEstimator({ items: [lamp] })(point, a, b).score, 60);
  assert.equal(
    osmEstimator({
      items: [lamp],
      ways: [
        {
          lit: 'no',
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
        },
      ],
    })(point, a, b).score,
    20,
  );
});
test('OSM estimates affect brightest-route ranking even without camera measurements', () => {
  const bright = scoreRoute(route, [], [], now, {
    ways: [
      {
        lit: 'yes',
        coordinates: [
          [0, 0],
          [0.002, 0],
        ],
      },
    ],
  });
  const dark = {
    ...scoreRoute(route, [], [], now, {
      ways: [
        {
          lit: 'no',
          coordinates: [
            [0, 0],
            [0.002, 0],
          ],
        },
      ],
    }),
    id: 'dark',
    duration_seconds: 500,
  };
  assert.equal(rankRoutes([dark, bright], 1)[0].id, route.id);
  assert.equal(rankRoutes([dark, bright], 0)[0].id, 'dark');
});
const route = {
  id: 'a',
  duration_seconds: 600,
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [0.002, 0],
    ],
  },
};
const m = (id, longitude, score, age = 0) => ({
  id,
  latitude: 0,
  longitude,
  score,
  is_night: true,
  timestamp: new Date(now - age * 86400000).toISOString(),
});
test('image analysis distinguishes black, white, and mixed images', () => {
  assert.equal(analyzePixels([0, 0, 0, 255]).score, 0);
  assert.equal(analyzePixels([255, 255, 255, 255]).score, 100);
  const mixed = analyzePixels([0, 0, 0, 255, 255, 255, 255, 255]);
  assert.equal(mixed.dark_fraction, 0.5);
  assert.equal(mixed.score, 50);
});
test('unknown coverage is not represented as darkness or an overall score', () => {
  const empty = scoreRoute(route, [], [], now);
  assert.equal(empty.score, null);
  assert.equal(empty.coverage, 0);
  const partial = scoreRoute(route, [m('1', 0, 90)], [], now);
  assert.equal(partial.score, null);
  assert.ok(partial.coverage > 0 && partial.coverage < 60);
  assert.equal(partial.measured_score, 90);
});
test('full coverage uses recent night data and age weighting', () => {
  const samples = [m('1', 0, 80), m('2', 0.001, 80), m('3', 0.002, 80)];
  const full = scoreRoute(route, samples, [], now);
  assert.equal(full.coverage, 100);
  assert.equal(full.score, 80);
  assert.equal(
    scoreRoute(
      route,
      samples.map((s) => ({ ...s, is_night: false })),
      [],
      now,
    ).score,
    null,
  );
  assert.equal(scoreRoute(route, [m('old', 0.001, 100, 31)], [], now).score, null);
  const weighted = scoreRoute(route, [...samples, m('old', 0.001, 0, 20)], [], now);
  assert.ok(weighted.score > 60);
});
test('only recent corroborated, unresolved reports penalize measured sections', () => {
  const samples = [m('1', 0, 80), m('2', 0.001, 80), m('3', 0.002, 80)];
  const report = { ...m('r', 0.001, 0), confirmations: 2, status: 'corroborated' };
  assert.ok(scoreRoute(route, samples, [report], now).score < 80);
  assert.equal(
    scoreRoute(route, samples, [{ ...report, status: 'community_resolved' }], now).score,
    80,
  );
  assert.equal(scoreRoute(route, samples, [{ ...report, confirmations: 0 }], now).score, 80);
});
test('preference changes ranking without giving unmeasured routes brightest status', () => {
  const fast = { id: 'fast', duration_seconds: 600, score: 20, measured_score: 20, coverage: 100 };
  const bright = {
    id: 'bright',
    duration_seconds: 720,
    score: 90,
    measured_score: 90,
    coverage: 100,
  };
  const unknown = {
    id: 'unknown',
    duration_seconds: 590,
    score: null,
    measured_score: null,
    coverage: 0,
  };
  assert.equal(rankRoutes([fast, bright], 0)[0].id, 'fast');
  assert.equal(rankRoutes([fast, bright, unknown], 1)[0].id, 'bright');
  assert.equal(rankRoutes([unknown], 1)[0].brightest, false);
});
