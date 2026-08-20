/**
 * Minimal, injectable stdout/stderr so command logic is testable without
 * capturing real process streams.
 */
export interface Io {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const processIo: Io = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** Collects lines instead of writing anywhere. Useful for tests. */
export function createCapturingIo(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}
