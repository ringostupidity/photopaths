export const $ = (id) => document.getElementById(id);
export function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error('Browser storage is unavailable. Enable storage to save your preferences.');
  }
}
export const settings = () => readLocal('photopath-settings', { units: 'km', preference: 50 });
export const formatDistance = (meters) =>
  settings().units === 'mi'
    ? `${(meters / 1609.344).toFixed(1)} mi`
    : meters < 1000
      ? `${Math.round(meters)} m`
      : `${(meters / 1000).toFixed(1)} km`;
export async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Photopath': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed. Please try again.');
  return data;
}
export function message(text, error = false, target = $('notice')) {
  if (!target) return;
  target.textContent = text;
  target.hidden = !text;
  target.classList.toggle('error', error);
}
export async function busy(button, task) {
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } catch (e) {
    message(e.message || 'Please try again.', true);
  } finally {
    button.disabled = false;
    button.textContent = label;
    button.removeAttribute('aria-busy');
  }
}
export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error('Location is unavailable in this browser.'));
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
        }),
      () =>
        reject(
          new Error(
            'Could not access your location. Check location permission or select a location on the map.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function button(text, action, className = 'secondary-button') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
export const coordsText = (p) => `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;
export function makeMap(id, center = [33.91, -117.89]) {
  const map = L.map(id).setView(center, 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  return map;
}
export async function shrinkPhoto(file) {
  if (!file?.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.');
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas'),
    scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const data = canvas.toDataURL('image/jpeg', 0.65);
  if (data.length > 280000) throw new Error('This photo is too detailed. Choose a smaller image.');
  return data;
}

const current = location.pathname.replace('.html', '').replace('/', '') || 'index';
const header = document.querySelector('[data-header]');
if (header) {
  const nav = element('nav', null, 'navbar');
  nav.setAttribute('aria-label', 'Main navigation');
  const logo = element('a', '💡 Photopath', 'logo');
  logo.href = '/';
  nav.append(logo);
  const links = element('div', null, 'nav-links');
  for (const [page, title] of [
    ['index', 'Home'],
    ['map', 'Map'],
    ['measure', 'Measure'],
    ['report', 'Report'],
    ['settings', 'My activity'],
  ]) {
    const a = element('a', title);
    a.href = page === 'index' ? '/' : `/${page}`;
    if (current === page) {
      a.className = 'active';
      a.setAttribute('aria-current', 'page');
    }
    links.append(a);
  }
  nav.append(links);
  header.append(nav);
}
const footer = document.querySelector('[data-footer]');
if (footer)
  footer.textContent =
    'Photopath · Community lighting information. A brighter route is not a guarantee of safety.';
// Establish one signed, anonymous identity before any parallel requests.
export const ready = api('/api/session');
ready.catch(() => message('The server is unavailable. Please refresh to reconnect.', true));
