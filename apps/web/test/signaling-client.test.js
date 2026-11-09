import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { SignalingClient } from '../src/services/signaling-client.js';

/** A free local port (the server for it starts later, like a sleeping host waking up). */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe('SignalingClient first connection', () => {
  test('waits for a server that only comes up after a few seconds (a sleeping host waking up)', async () => {
    const port = await freePort();
    const client = new SignalingClient(`ws://127.0.0.1:${port}/ws`);
    let retries = 0;
    let server;
    const wake = setTimeout(() => {
      server = new WebSocketServer({ host: '127.0.0.1', port, path: '/ws' });
    }, 2500);
    try {
      await client.connect({ deadlineMs: 20_000, onRetry: () => retries++ });
      assert.equal(client.online, true);
      assert.ok(retries >= 1, 'it retried while the server was down');
    } finally {
      clearTimeout(wake);
      client.close();
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    }
  });

  test('gives up with a clear message once the deadline passes', async () => {
    const port = await freePort();
    const client = new SignalingClient(`ws://127.0.0.1:${port}/ws`);
    const started = Date.now();
    await assert.rejects(client.connect({ deadlineMs: 2500 }), /Couldn't reach the Hopline server/);
    assert.ok(Date.now() - started < 10_000, 'did not hang');
    client.close();
  });
});
