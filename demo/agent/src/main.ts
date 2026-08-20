/**
 * Process entry point: `npm run demo:agent`.
 */
import { runDemoAgent } from './run.js';

const exitCode = await runDemoAgent();
process.exitCode = exitCode;
