// Vercel entry point. Local development continues to use server.js.
import express from 'express';
import { createApp } from './src/app.js';
import { Store } from './src/store.js';
import { createProviders } from './src/providers.js';

const app = express();
createApp({
  app,
  store: new Store(process.env.UPSTASH_REDIS_URL),
  providers: createProviders(),
  secret: process.env.SESSION_SECRET,
  production: true,
});
// Vercel supplies the client address through its reverse proxy.
if (process.env.VERCEL === '1') app.set('trust proxy', 1);

export default app;
