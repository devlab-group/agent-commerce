/**
 * Injectable stdout/stderr, so command logic is testable without capturing
 * the real process streams
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
