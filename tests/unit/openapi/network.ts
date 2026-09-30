import { Socket } from 'node:net';
import { expect, vi } from 'vitest';

/**
 * Refuses every outbound TCP connection and records the attempt. fetch, http,
 * https and raw TCP sockets all call `Socket#connect`, so a zero count means no
 * code on this thread tried to connect. A local fetch runs first to prove the
 * spy sees one. Restore it with `vi.restoreAllMocks()` or `mockRestore()`.
 */
export async function blockOutboundConnections() {
  const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
    throw new Error('outbound connection blocked by the test');
  });
  await expect(fetch('http://127.0.0.1:59999/')).rejects.toThrow();
  expect(connect).toHaveBeenCalledTimes(1);
  connect.mockClear();
  return connect;
}
