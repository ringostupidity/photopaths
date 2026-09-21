import { createApp } from '../src/app.js';
import { MemoryStore, fixtureProviders } from './helpers.js';
createApp({
  store: new MemoryStore(),
  providers: fixtureProviders,
  secret: 'browser-test-secret-'.repeat(3),
  limits: false,
}).listen(5055, '127.0.0.1');
