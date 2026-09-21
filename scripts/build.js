import { cp, mkdir } from 'node:fs/promises';

// Vercel serves public/ directly; express.static(node_modules/...) is not supported.
const destination = new URL('../public/vendor/leaflet/', import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL('../node_modules/leaflet/dist/', import.meta.url), destination, {
  recursive: true,
});
await cp(
  new URL('../node_modules/leaflet/LICENSE', import.meta.url),
  new URL('LICENSE', destination),
);
console.log('Leaflet browser assets copied to public/vendor/leaflet.');
