import { Store } from './src/store.js';
import { createProviders } from './src/providers.js';
import { createApp } from './src/app.js';

try {
  const store = new Store(process.env.UPSTASH_REDIS_URL);
  const app = createApp({
    store,
    providers: createProviders(),
    secret: process.env.SESSION_SECRET,
    production: process.env.NODE_ENV === 'production',
  });
  const port = Number(process.env.PORT || 5000),
    host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host);
  server.once('listening', () => {
    console.log(`Photopath is running at http://${host}:${port}`);
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use at ${host}. Stop the existing server before running npm.cmd start again, or choose a different PORT in .env.`,
      );
    } else {
      console.error(
        `Could not listen on ${host}:${port} (${error.code || 'unknown error'}). Check HOST and PORT in .env.`,
      );
    }
    store.close();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
