// Demo merchant API entry point: `npm run demo:merchant`, or `dev:merchant` to watch
import { buildApp } from './app';

const port = Number(process.env.MERCHANT_API_PORT ?? 3000);
const host = '0.0.0.0';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error({ err }, 'demo-store: failed to start');
    process.exitCode = 1;
  }
}

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'demo-store: shutting down');
  app
    .close()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      app.log.error({ err }, 'demo-store: error during shutdown');
      process.exitCode = 1;
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void start();
