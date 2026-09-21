import {
  $,
  api,
  ready,
  busy,
  message,
  locate,
  element,
  button,
  makeMap,
  settings,
  readLocal,
  writeLocal,
  formatDistance,
  coordsText,
} from './common.js';
import { scoreColor, scoreLabel } from './lighting.js';

await ready;
const map = makeMap('map');
const layers = {
  measurements: L.layerGroup().addTo(map),
  reports: L.layerGroup().addTo(map),
  lamps: L.layerGroup().addTo(map),
};
let start,
  end,
  startMarker,
  endMarker,
  routes = [],
  routeLayers = [],
  routeGeneration = 0,
  areaGeneration = 0;
let selectedId;
let pickTarget = null;
function setPickTarget(which, scroll = false) {
  pickTarget = which;
  for (const name of ['start', 'end']) {
    $(`pick-${name}`).setAttribute('aria-pressed', String(which === name));
  }
  $('map').classList.toggle('picking', Boolean(which));
  $('pick-status').hidden = !which;
  $('pick-status').textContent =
    which === 'start'
      ? 'Click or tap to place the starting pin'
      : 'Click or tap to place the destination pin';
  if (scroll) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
for (const which of ['start', 'end']) {
  $(`pick-${which}`).addEventListener('click', () =>
    setPickTarget(pickTarget === which ? null : which, true),
  );
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setPickTarget(null);
});
const favorites = () => readLocal('photopath-favorites', []);
const preference = $('preference');
preference.value = settings().preference;
function preferenceLabel() {
  $('preference-value').textContent =
    preference.value < 25 ? 'Time first' : preference.value > 75 ? 'Light first' : 'Balanced';
}
preferenceLabel();
function clearRoutes() {
  routeGeneration++;
  routes = [];
  routeLayers.forEach((l) => map.removeLayer(l));
  routeLayers = [];
  $('routes').replaceChildren(
    element('p', 'Set a start and destination to compare walking routes.', 'empty'),
  );
  $('directions').hidden = true;
}
function setPoint(which, point, name) {
  clearRoutes();
  const p = {
    latitude: point.latitude ?? point.lat,
    longitude: point.longitude ?? point.lon,
    name:
      name ||
      point.name ||
      coordsText({
        latitude: point.latitude ?? point.lat,
        longitude: point.longitude ?? point.lon,
      }),
  };
  const marker = L.marker([p.latitude, p.longitude], {
    draggable: true,
    title: which === 'start' ? 'Starting point (drag to move)' : 'Destination (drag to move)',
  }).bindPopup(element('span', `${which === 'start' ? 'Start' : 'Destination'}: ${p.name}`));
  marker.on('dragend', () => {
    const point = marker.getLatLng();
    setPoint(which, { lat: point.lat, lon: point.lng });
    message(
      `${which === 'start' ? 'Starting point' : 'Destination'} moved. Compare routes to update your walk.`,
    );
  });
  if (which === 'start') {
    start = p;
    if (startMarker) map.removeLayer(startMarker);
    startMarker = marker.addTo(map);
    $('start').value = p.name;
  } else {
    end = p;
    if (endMarker) map.removeLayer(endMarker);
    endMarker = marker.addTo(map);
    $('destination').value = p.name;
  }
  $(`${which}-results`).replaceChildren();
  setPickTarget(null);
}
function pickPoint(e) {
  const which = pickTarget || (!start ? 'start' : !end ? 'end' : null);
  if (!which) return;
  setPoint(which, { latitude: e.latlng.lat, longitude: e.latlng.lng });
  message(
    which === 'start'
      ? 'Starting point selected. Choose a destination or compare routes.'
      : 'Destination selected. Compare routes when ready.',
  );
}
map.on('click', pickPoint);
for (const [which, id] of [
  ['start', 'start'],
  ['end', 'destination'],
]) {
  let generation = 0;
  $(id).addEventListener('input', () => {
    generation++;
    if (which === 'start') {
      start = null;
      if (startMarker) map.removeLayer(startMarker);
    } else {
      end = null;
      if (endMarker) map.removeLayer(endMarker);
    }
    $(`${which}-results`).replaceChildren();
    clearRoutes();
  });
  $(`search-${which}`).addEventListener('click', (e) =>
    busy(e.currentTarget, async () => {
      const query = $(id).value.trim();
      if (!query) throw new Error('Enter a place name or address.');
      const ticket = ++generation;
      const data = await api('/api/geocode', { query });
      if (ticket !== generation) return;
      $(`${which}-results`).replaceChildren(
        ...data.results.map((p) =>
          button(
            p.name,
            () => {
              generation++;
              setPoint(which, p);
              map.setView([p.lat, p.lon], 15);
              message('Location selected.');
            },
            'result',
          ),
        ),
      );
      message('Choose the matching place from the search results.');
    }),
  );
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $(`search-${which}`).click();
    }
  });
}
$('locate').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    message('Finding your location…');
    const p = await locate();
    setPoint('start', p, 'My current location');
    map.setView([p.latitude, p.longitude], 16);
    message(`Location found (accuracy about ${Math.round(p.accuracy)} m).`);
    await refreshData();
  }),
);
async function fetchRoutes() {
  if (!start || !end)
    throw new Error('Choose both locations from search results, GPS, or the map.');
  const ticket = ++routeGeneration;
  message('Finding walking routes and checking lighting…');
  const data = await api('/api/route', { start, end, preference: Number(preference.value) / 100 });
  if (ticket !== routeGeneration) return;
  routes = data.routes;
  rankLocally();
  drawRoutes();
  if (routeLayers.length)
    map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [30, 30] });
  message(
    data.warning ||
      (routes.length === 1
        ? 'One walking route is available for these locations.'
        : `${routes.length} walking routes found.`),
  );
}
$('route-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('route-submit'), fetchRoutes);
});
preference.addEventListener('input', preferenceLabel);
preference.addEventListener('change', () => {
  if (!routes.length) return;
  rankLocally();
  drawRoutes();
});
function rankLocally() {
  const weight = Number(preference.value) / 100,
    fastest = Math.min(...routes.map((r) => r.duration_seconds));
  routes = routes
    .map((r) => ({
      ...r,
      cost:
        ((1 - weight) * r.duration_seconds) / fastest +
        weight *
          (r.covered_score == null
            ? 1
            : (r.coverage / 100) * (1 - r.covered_score / 100) + 1 - r.coverage / 100),
    }))
    .sort((a, b) => a.cost - b.cost || a.duration_seconds - b.duration_seconds)
    .map((r, i) => ({ ...r, recommended: i === 0 }));
}
function drawRoutes() {
  routeLayers.forEach((l) => map.removeLayer(l));
  routeLayers = [];
  $('routes').replaceChildren();
  routes.forEach((r) => {
    const group = L.featureGroup();
    for (const section of r.sections)
      L.polyline(
        section.coordinates.map((p) => [p[1], p[0]]),
        {
          color: scoreColor(section.score),
          weight: 5,
          opacity: 0.6,
          dashArray:
            section.score == null ? '7 7' : section.source?.startsWith('osm') ? '10 3' : null,
          bubblingMouseEvents: false,
        },
      ).addTo(group);
    group.addTo(map).on('click', (e) => (pickTarget ? pickPoint(e) : selectRoute(r.id)));
    routeLayers.push(group);
    const card = button('', () => selectRoute(r.id), 'route');
    card.dataset.id = r.id;
    const badges = [
      r.recommended && 'Recommended',
      r.fastest && 'Fastest',
      r.brightest && 'Highest lighting estimate',
    ].filter(Boolean);
    card.append(element('div', badges.join(' · '), 'route-badges'));
    const top = element('div', null, 'route-top');
    top.append(
      element('span', `${Math.max(1, r.duration)} min walk`),
      element(
        'span',
        r.score == null
          ? 'Not enough coverage'
          : `${r.score}/100${r.source === 'camera' ? '' : ' est.'}`,
      ),
    );
    const meta = element('div', null, 'route-meta');
    meta.append(
      element('span', formatDistance(r.distance)),
      element('span', `${r.coverage}% lighting coverage`),
    );
    const coverage = element('div', null, 'coverage'),
      fill = element('span');
    fill.style.width = `${r.coverage}%`;
    coverage.append(fill);
    card.append(
      top,
      meta,
      coverage,
      element('p', `${r.measured_coverage}% camera · ${r.osm_coverage}% OSM estimate`, 'hint'),
      element(
        'p',
        `${r.sample_count} readings · ${r.report_count} nearby reports${r.covered_score != null && r.score == null ? ` · Covered sections: ${r.covered_score}/100` : ''}`,
        'hint',
      ),
    );
    $('routes').append(card);
  });
  selectRoute(routes[0]?.id);
}
function selectRoute(id) {
  selectedId = id;
  routes.forEach((r, i) => {
    routeLayers[i].setStyle({ weight: r.id === id ? 7 : 4, opacity: r.id === id ? 0.95 : 0.4 });
    if (r.id === id) routeLayers[i].bringToFront();
  });
  document.querySelectorAll('.route').forEach((n) => {
    n.classList.toggle('selected', n.dataset.id === id);
    n.setAttribute('aria-pressed', String(n.dataset.id === id));
  });
  const chosen = routes.find((r) => r.id === selectedId);
  $('directions').hidden = !chosen;
  $('steps').replaceChildren(
    ...(chosen?.steps ?? []).map((s) =>
      element('li', `${s.instruction} · ${formatDistance(s.distance)}`),
    ),
  );
}
$('clear-route').addEventListener('click', () => {
  clearRoutes();
  start = end = null;
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  $('start').value = '';
  $('destination').value = '';
  setPickTarget(null);
  message('Route cleared.');
});
function renderFavorites() {
  $('favorites').replaceChildren(
    ...favorites().map((p) =>
      button(
        `☆ ${p.name}`,
        () => {
          setPoint('end', p);
          map.setView([p.latitude, p.longitude], 15);
        },
        'result',
      ),
    ),
  );
}
$('save-favorite').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    if (!end) throw new Error('Choose a destination before saving it.');
    const all = favorites();
    if (all.length >= 20)
      throw new Error('You can save up to 20 places. Manage them in My activity.');
    if (!all.some((p) => p.latitude === end.latitude && p.longitude === end.longitude))
      writeLocal('photopath-favorites', [...all, end]);
    renderFavorites();
    message('Destination saved to this browser.');
  }),
);
renderFavorites();
function measurementPopup(m) {
  const box = element('div', null, 'popup');
  box.append(
    element('strong', `${m.score}/100 · ${scoreLabel(m.score)}`),
    element('p', new Date(m.timestamp).toLocaleString(), 'hint'),
    element('p', 'Camera estimate, not a lux reading.', 'hint'),
  );
  return box;
}
function reportPopup(r) {
  const box = element('div', null, 'popup');
  box.append(
    element('strong', `${r.report_type.replaceAll('_', ' ')} light`),
    element('p', r.description || 'No description supplied.'),
    element('span', r.status.replaceAll('_', ' '), 'pill'),
    element('p', `${r.confirmations} confirmations · ${r.repair_votes} repair votes`, 'hint'),
    element('p', new Date(r.timestamp).toLocaleString(), 'hint'),
  );
  if (r.photo) {
    const image = element('img');
    image.src = r.photo;
    image.alt = 'Community report photo';
    box.append(image);
  }
  for (const [action, label] of [
    ['confirm', 'I see this problem too'],
    ['repaired', 'This light is repaired'],
  ]) {
    const b = button(
      label,
      () =>
        busy(b, async () => {
          await api(`/api/reports/${r.id}/verify`, { action });
          message('Thanks. Your review has been recorded.');
          await refreshData();
        }),
      'secondary-button',
    );
    box.append(b);
  }
  return box;
}
async function refreshData() {
  const ticket = ++areaGeneration,
    c = map.getCenter();
  const data = await api(`/api/nearby?lat=${c.lat}&lon=${c.lng}&radius=2000`);
  if (ticket !== areaGeneration) return;
  layers.measurements.clearLayers();
  layers.reports.clearLayers();
  const readings = data.measurements.filter(
    (m) => m.is_night && Date.now() - Date.parse(m.timestamp) < 30 * 86400000,
  );
  readings.forEach((m) =>
    L.circle([m.latitude, m.longitude], {
      radius: 35,
      color: scoreColor(m.score),
      fillOpacity: 0.3,
      weight: 2,
    })
      .bindPopup(measurementPopup(m))
      .addTo(layers.measurements),
  );
  data.reports.forEach((r) =>
    L.circleMarker([r.latitude, r.longitude], {
      radius: 7,
      color: 'white',
      weight: 2,
      fillColor: r.status === 'community_resolved' ? '#358454' : '#b73943',
      fillOpacity: 1,
    })
      .bindPopup(reportPopup(r))
      .addTo(layers.reports),
  );
  $('layer-status').textContent =
    `Photopath: ${readings.length} nighttime camera readings · ${data.reports.length} reports within 2 km.${readings.length ? '' : ' No community measurements yet; this does not mean OSM has no lighting data.'}${data.truncated ? ' Results limited to the nearest 500 items per layer.' : ''}`;
}
$('refresh-data').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    await refreshData();
    message('Community data refreshed around the map center.');
  }),
);
$('load-lamps').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    const c = map.getCenter(),
      data = await api(`/api/streetlights?lat=${c.lat}&lon=${c.lng}&radius=2000`);
    layers.lamps.clearLayers();
    for (const way of data.ways || []) {
      const popup = element('div', null, 'popup');
      popup.append(
        element('strong', way.name || 'Mapped road or path'),
        element('p', `OSM lighting tag: ${way.lit}. Not a measured brightness reading.`),
      );
      const link = element('a', 'View in OpenStreetMap');
      link.href = `https://www.openstreetmap.org/way/${way.id}`;
      popup.append(link);
      L.polyline(
        way.coordinates.map((p) => [p[1], p[0]]),
        {
          color: ['yes', '24/7'].includes(way.lit)
            ? '#3157d5'
            : way.lit === 'no'
              ? '#68727d'
              : '#8c54ae',
          dashArray: way.lit === 'no' ? '5 7' : '3 5',
          weight: 4,
          opacity: 0.75,
        },
      )
        .bindPopup(popup)
        .addTo(layers.lamps);
    }
    data.items.forEach((l) =>
      L.circleMarker([l.latitude, l.longitude], {
        radius: 4,
        color: '#947716',
        fillColor: '#f5cf5d',
        fillOpacity: 0.9,
        weight: 1,
      })
        .bindPopup(element('span', l.status))
        .addTo(layers.lamps),
    );
    const status = `OSM: ${data.items.length} mapped streetlights · ${data.ways?.length || 0} roads/paths with lighting tags within 2 km.${data.truncated ? ' Results limited to 500 per type.' : ''} These tags do not measure brightness.`;
    $('osm-status').textContent = status;
    message(status);
  }),
);
for (const name of Object.keys(layers))
  $(`show-${name}`).addEventListener('change', (e) =>
    e.target.checked ? layers[name].addTo(map) : map.removeLayer(layers[name]),
  );
const params = new URLSearchParams(location.search);
if (params.has('lat') && params.has('lon')) {
  const lat = Number(params.get('lat')),
    lon = Number(params.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180) {
    map.setView([lat, lon], 17);
    if (params.get('destination') === '1')
      setPoint('end', { lat, lon }, params.get('name') || 'Saved place');
  }
}
refreshData().catch((e) => message(e.message, true));
