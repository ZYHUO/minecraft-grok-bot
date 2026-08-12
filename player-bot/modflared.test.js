'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isLocalHost,
  splitHostPort,
  parseTunnelTxt,
  lookupTunnelHostname,
  openModflaredTunnel,
} = require('./modflared');

test('isLocalHost', () => {
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('192.168.1.2'), true);
  assert.equal(isLocalHost('10.0.0.8'), true);
  assert.equal(isLocalHost('172.16.0.1'), true);
  assert.equal(isLocalHost('play.example.net'), false);
});

test('splitHostPort', () => {
  assert.deepEqual(splitHostPort('play.example.net', 25565), {
    host: 'play.example.net',
    port: 25565,
  });
  assert.deepEqual(splitHostPort('play.example.net:25566', 25565), {
    host: 'play.example.net',
    port: 25566,
  });
  assert.deepEqual(splitHostPort('[::1]:25566', 25565), {
    host: '::1',
    port: 25566,
  });
});

test('parseTunnelTxt', () => {
  assert.deepEqual(parseTunnelTxt([['cloudflared-use-tunnel']]), {
    use: true,
    route: null,
  });
  assert.deepEqual(parseTunnelTxt([['cloudflared-route=inner.example.net']]), {
    use: true,
    route: 'inner.example.net',
  });
  assert.deepEqual(parseTunnelTxt(['cloudflared-route=inner.example.net']), {
    use: true,
    route: 'inner.example.net',
  });
  assert.deepEqual(parseTunnelTxt([['hello']]), { use: false, route: null });
});

test('lookupTunnelHostname', async () => {
  assert.equal(
    await lookupTunnelHostname('play.example.net', async () => [['cloudflared-use-tunnel']]),
    'play.example.net'
  );
  assert.equal(
    await lookupTunnelHostname('play.example.net', async () => [['cloudflared-route=inner.example.net']]),
    'inner.example.net'
  );
  assert.equal(await lookupTunnelHostname('play.example.net', async () => [['hello']]), null);
  assert.equal(
    await lookupTunnelHostname('play.example.net', async () => {
      const e = new Error('nx');
      e.code = 'ENOTFOUND';
      throw e;
    }),
    null
  );
});

test('openModflaredTunnel skips local auto and off', async () => {
  assert.equal(await openModflaredTunnel({ host: '127.0.0.1', port: 25565, mode: 'auto' }), null);
  assert.equal(await openModflaredTunnel({ host: 'play.example.net', port: 25565, mode: 'off' }), null);
});

test('openModflaredTunnel on + loopback needs tunnel-host', async () => {
  await assert.rejects(
    () => openModflaredTunnel({ host: '127.0.0.1', port: 25565, mode: 'on' }),
    /forced_tunnels|public hostname/
  );
});
