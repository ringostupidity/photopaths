import {
  $,
  api,
  ready,
  busy,
  message,
  locate,
  coordsText,
  makeMap,
  shrinkPhoto,
} from './common.js';
await ready;
const map = makeMap('report-map');
let marker,
  photo = null,
  photoPending = false;
function setLocation(p) {
  $('latitude').value = p.latitude.toFixed(6);
  $('longitude').value = p.longitude.toFixed(6);
  if (marker) map.removeLayer(marker);
  marker = L.marker([p.latitude, p.longitude]).addTo(map);
  $('location-status').textContent = `Selected: ${coordsText(p)}`;
}
map.on('click', (e) => setLocation({ latitude: e.latlng.lat, longitude: e.latlng.lng }));
$('report-location').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    message('Finding your location…');
    const p = await locate();
    setLocation(p);
    map.setView([p.latitude, p.longitude], 17);
    message(`Location found (accuracy about ${Math.round(p.accuracy)} m).`);
  }),
);
for (const id of ['latitude', 'longitude'])
  $(id).addEventListener('change', () => {
    if ($('latitude').value === '' || $('longitude').value === '') return;
    const p = { latitude: Number($('latitude').value), longitude: Number($('longitude').value) };
    if (Math.abs(p.latitude) <= 85 && Math.abs(p.longitude) <= 180) {
      setLocation(p);
      map.setView([p.latitude, p.longitude], 17);
    }
  });
$('photo').addEventListener('change', async () => {
  photo = null;
  $('photo-preview').hidden = true;
  const file = $('photo').files[0];
  if (!file) return;
  photoPending = true;
  $('submit-report').disabled = true;
  try {
    photo = await shrinkPhoto(file);
    $('photo-preview').src = photo;
    $('photo-preview').hidden = false;
  } catch (e) {
    $('photo').value = '';
    message(e.message, true);
  } finally {
    photoPending = false;
    $('submit-report').disabled = false;
  }
});
$('report-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (photoPending) return;
  busy($('submit-report'), async () => {
    const latitude = Number($('latitude').value),
      longitude = Number($('longitude').value);
    await api('/api/reports', {
      latitude,
      longitude,
      report_type: $('problem').value,
      description: $('description').value,
      photo,
      consent: $('consent').checked,
    });
    $('report-form').reset();
    photo = null;
    $('photo-preview').hidden = true;
    if (marker) map.removeLayer(marker);
    $('location-status').textContent = 'Click the map, use GPS, or enter coordinates below.';
    message('Report saved to the community map. You can manage it in My activity.');
    $('notice').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});
