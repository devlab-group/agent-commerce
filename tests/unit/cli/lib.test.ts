import { describe, expect, it } from 'vitest';
import { type FetchLike, fetchJson } from '../../../src/cli/lib/http';
import { processIo } from '../../../src/cli/lib/io';
import { maskMiddle } from '../../../src/cli/lib/mask';
import { readVersionReport } from '../../../src/cli/lib/versions';
import { createFakeFetch, jsonResponse } from './fixtures';

describe('maskMiddle', () => {
  it('masks the middle of a long value, keeping a prefix and suffix', () => {
    expect(maskMiddle('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('0xf39F…2266');
  });

  it('masks a short value entirely rather than printing it (observation)', () => {
    // `maskMiddle` never prints a full value, so a short secret passed to it
    // does not leak
    expect(maskMiddle('short')).toBe('…');
    expect(maskMiddle('')).toBe('');
  });
});

describe('fetchJson', () => {
  it('returns ok + body for a successful JSON response', async () => {
    const fetchImpl = createFakeFetch({
      'http://x/ok': () => jsonResponse({ hello: 'world' }, 200),
    });
    const result = await fetchJson(fetchImpl, 'http://x/ok');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ hello: 'world' });
  });

  it('returns ok:false with the status for a non-2xx response', async () => {
    const fetchImpl = createFakeFetch({
      'http://x/missing': () => jsonResponse({ error: 'nope' }, 404),
    });
    const result = await fetchJson(fetchImpl, 'http://x/missing');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it('returns status 0 and an error message when the fetch itself throws (unreachable)', async () => {
    const fetchImpl = createFakeFetch({});
    const result = await fetchJson(fetchImpl, 'http://x/unreachable');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('falls back to a generic error message when a non-Error value is thrown', async () => {
    const fetchImpl: FetchLike = (async () => {
      throw 'not an Error instance';
    }) as unknown as FetchLike;
    const result = await fetchJson(fetchImpl, 'http://x/weird-throw');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown fetch error');
  });

  it('gives up once the timeout passes', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as FetchLike;
    const result = await fetchJson(fetchImpl, 'http://x/slow', 10);
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(result.error).toMatch(/timeout/i);
  });

  it('tolerates a non-JSON body without throwing', async () => {
    const fetchImpl = createFakeFetch({
      'http://x/text': () => new Response('not json', { status: 200 }),
    });
    const result = await fetchJson(fetchImpl, 'http://x/text');
    expect(result.ok).toBe(true);
    expect(result.body).toBeUndefined();
  });
});

describe('readVersionReport', () => {
  it('reads a CLI version and a non-empty set of pinned versions', () => {
    const report = readVersionReport();
    expect(report.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.pinned.length).toBeGreaterThan(0);
    for (const pin of report.pinned) {
      expect(pin.name.length).toBeGreaterThan(0);
      expect(pin.version.length).toBeGreaterThan(0);
      expect(pin.via.length).toBeGreaterThan(0);
    }
  });
});

describe('io', () => {
  it('processIo actually writes a newline-terminated line to stdout/stderr', () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: matching Node's overloaded Writable#write signature
    (process.stdout.write as any) = (chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    };
    // biome-ignore lint/suspicious/noExplicitAny: matching Node's overloaded Writable#write signature
    (process.stderr.write as any) = (chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    };
    try {
      processIo.stdout('hello');
      processIo.stderr('oops');
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    expect(stdoutChunks).toEqual(['hello\n']);
    expect(stderrChunks).toEqual(['oops\n']);
  });
});
