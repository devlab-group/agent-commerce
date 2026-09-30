// Process entry point: `npm run demo:agent`
import { runDemoAgent } from './run';

const exitCode = await runDemoAgent();
process.exitCode = exitCode;
