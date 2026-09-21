// Heuristic priors on the same 0–100 scale as camera scores, not measured luminance.
// Match line segments rather than way centers so long mapped streets work correctly.
const PRIORS = { yes: 70, '24/7': 70, no: 20, limited: 50, automatic: 60 };
export function osmEstimator(osm = {}) {
  const segments = (osm.ways || []).flatMap((way) => {
    const score = PRIORS[way.lit];
    if (score === undefined) return [];
    return way.coordinates
      .slice(1)
      .map((b, i) => ({ a: way.coordinates[i], b, score, lit: way.lit }));
  });
  return (point, routeA, routeB) => {
    const xScale = 111195 * Math.cos((point.latitude * Math.PI) / 180),
      yScale = 111195;
    const rx = (routeB.longitude - routeA.longitude) * xScale;
    const ry = (routeB.latitude - routeA.latitude) * yScale;
    const rLength = Math.hypot(rx, ry);
    let closest = null,
      closestDistance = 20;
    for (const segment of segments) {
      const ax = (segment.a[0] - point.longitude) * xScale,
        ay = (segment.a[1] - point.latitude) * yScale;
      const bx = (segment.b[0] - point.longitude) * xScale,
        by = (segment.b[1] - point.latitude) * yScale;
      if (
        Math.min(ax, bx) > 20 ||
        Math.max(ax, bx) < -20 ||
        Math.min(ay, by) > 20 ||
        Math.max(ay, by) < -20
      )
        continue;
      const dx = bx - ax,
        dy = by - ay,
        length = Math.hypot(dx, dy);
      if (!length || !rLength || Math.abs((dx * rx + dy * ry) / (length * rLength)) < 0.7) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (length * length)));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d <= closestDistance) {
        closestDistance = d;
        closest = segment;
      }
    }
    if (closest) return { score: closest.score, source: 'osm_way', lit: closest.lit };
    const lamp = (osm.items || []).some(
      (l) =>
        Math.hypot(
          (l.longitude - point.longitude) * xScale,
          (l.latitude - point.latitude) * yScale,
        ) <= 35,
    );
    return lamp ? { score: 60, source: 'osm_lamp' } : null;
  };
}
