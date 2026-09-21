import { scoreLabel } from '../public/lighting.js';
import { osmEstimator } from './osm-estimates.js';
const R = 6371000,
  rad = Math.PI / 180;
export function distance(a, b) {
  const dLat = (b.latitude - a.latitude) * rad,
    dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function scoreRoute(route, measurements, reports, now = Date.now(), osm = {}) {
  const estimate = osmEstimator(osm);
  const recent = measurements.filter(
    (m) =>
      m.is_night &&
      now - Date.parse(m.timestamp) >= 0 &&
      now - Date.parse(m.timestamp) < 30 * 86400000,
  );
  const activeReports = reports.filter(
    (r) => r.status !== 'community_resolved' && now - Date.parse(r.timestamp) < 30 * 86400000,
  );
  let total = 0,
    covered = 0,
    weighted = 0,
    measuredLength = 0,
    measuredWeighted = 0,
    osmLength = 0;
  const sections = [],
    used = new Set(),
    issues = new Set();
  const coordinates = route.geometry.coordinates;
  for (let i = 1; i < coordinates.length; i++) {
    const a = { longitude: coordinates[i - 1][0], latitude: coordinates[i - 1][1] };
    const b = { longitude: coordinates[i][0], latitude: coordinates[i][1] };
    const length = distance(a, b),
      steps = Math.max(1, Math.ceil(length / 50));
    for (let j = 0; j < steps; j++) {
      const fraction = (j + 0.5) / steps;
      const point = {
        latitude: a.latitude + (b.latitude - a.latitude) * fraction,
        longitude: a.longitude + (b.longitude - a.longitude) * fraction,
      };
      const nearby = recent.filter((m) => distance(point, m) <= 60);
      const problems = activeReports.filter((r) => distance(point, r) <= 60);
      problems.forEach((r) => issues.add(r.id));
      let score = null,
        source = 'unknown';
      if (nearby.length) {
        let weights = 0,
          values = 0;
        nearby.forEach((m) => {
          const weight = 2 ** (-(now - Date.parse(m.timestamp)) / (7 * 86400000));
          values += m.score * weight;
          weights += weight;
          used.add(m.id);
        });
        score = Math.max(
          0,
          values / weights - Math.min(20, problems.filter((r) => r.confirmations >= 2).length * 10),
        );
        source = 'camera';
        measuredLength += length / steps;
        measuredWeighted += (score * length) / steps;
      } else {
        const fallback = estimate(point, a, b);
        if (fallback) {
          score = Math.max(
            0,
            fallback.score - Math.min(20, problems.filter((r) => r.confirmations >= 2).length * 10),
          );
          source = fallback.source;
          osmLength += length / steps;
        }
      }
      if (score !== null) {
        weighted += (score * length) / steps;
        covered += length / steps;
      }
      total += length / steps;
      const interpolate = (f) => [
        a.longitude + (b.longitude - a.longitude) * f,
        a.latitude + (b.latitude - a.latitude) * f,
      ];
      sections.push({
        coordinates: [interpolate(j / steps), interpolate((j + 1) / steps)],
        score: score == null ? null : Math.round(score),
        source,
      });
    }
  }
  const coverage = total ? covered / total : 0;
  const covered_score = covered ? Math.round(weighted / covered) : null;
  const measured_score = measuredLength ? Math.round(measuredWeighted / measuredLength) : null;
  const score = coverage >= 0.6 ? covered_score : null;
  return {
    ...route,
    score,
    measured_score,
    covered_score,
    measured_coverage: total ? Math.round((measuredLength / total) * 100) : 0,
    osm_coverage: total ? Math.round((osmLength / total) * 100) : 0,
    source: osmLength ? (measuredLength ? 'mixed' : 'osm') : measuredLength ? 'camera' : 'unknown',
    coverage: Math.round(coverage * 100),
    sample_count: used.size,
    report_count: issues.size,
    visibility: scoreLabel(score),
    sections,
  };
}
export function rankRoutes(routes, preference = 0.5) {
  const fastest = Math.min(...routes.map((r) => r.duration_seconds));
  // Unknown sections receive maximum uncertainty cost, without inventing a visibility score.
  const ranked = routes
    .map((r) => {
      const coverage = r.coverage / 100;
      const darkness =
        (r.covered_score ?? r.measured_score) == null
          ? 1
          : coverage * (1 - (r.covered_score ?? r.measured_score) / 100) + (1 - coverage);
      return {
        ...r,
        cost: ((1 - preference) * r.duration_seconds) / fastest + preference * darkness,
      };
    })
    .sort((a, b) => a.cost - b.cost || a.duration_seconds - b.duration_seconds);
  const eligible = routes.filter((r) => r.score != null);
  const brightest = eligible.length ? Math.max(...eligible.map((r) => r.score)) : null;
  return ranked.map((r, i) => ({
    ...r,
    recommended: i === 0,
    fastest: r.duration_seconds === fastest,
    brightest: brightest != null && r.score === brightest,
  }));
}
