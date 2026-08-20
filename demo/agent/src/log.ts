/**
 * Plain, prefixed output — style. No spinners, no progress theatre:
 * each line is one fact, printed once, as it happens.
 */
import pc from 'picocolors';

export type LogFn = (message: string) => void;

export interface DemoLogger {
  readonly agent: LogFn;
  readonly gateway: LogFn;
  readonly buyer: LogFn;
  readonly receipt: LogFn;
}

export function createDemoLogger(write: (line: string) => void = defaultWrite): DemoLogger {
  return {
    agent: (message) => write(`${pc.cyan('[agent]')} ${message}`),
    gateway: (message) => write(`${pc.magenta('[gateway]')} ${message}`),
    buyer: (message) => write(`${pc.yellow('[buyer]')} ${message}`),
    receipt: (message) => write(`${pc.green('[receipt]')} ${message}`),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}
