// Entry point for `npm run demo:gateway` and the Docker gateway service.
// `agent-commerce start` runs the same `runGateway`.
import { printStartupError, runGateway } from './run';

runGateway().catch((error: unknown) => {
  printStartupError(error);
  process.exit(1);
});
