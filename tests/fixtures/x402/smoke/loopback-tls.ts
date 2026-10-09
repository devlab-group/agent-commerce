/**
 * HTTPS for the facilitator the harness runs on 127.0.0.1. A mainnet gateway
 * refuses a plain-HTTP facilitator, so the run creates a throwaway certificate
 * and trusts it for that one origin; every other request keeps the default
 * certificate checks.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A self-signed certificate for 127.0.0.1, valid for a day; needs the `openssl` CLI */
export function loopbackCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oac-smoke-tls-'));
  try {
    const created = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    if (created.status !== 0) {
      throw new Error(`openssl could not create the loopback certificate: ${created.stderr}`);
    }
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sends `fetch` requests for `origin` through `node:https` with `ca` as the
 * only trusted root. Returns the function that restores the original `fetch`.
 */
export function trustLoopback(origin: string, ca: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    if (new URL(outgoing.url).origin !== origin) return original(input, init);
    const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        outgoing.url,
        {
          method: outgoing.method,
          headers: Object.fromEntries(outgoing.headers),
          ca,
          signal: outgoing.signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              for (const item of [value ?? []].flat()) headers.append(name, item);
            }
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500, headers }),
            );
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}
