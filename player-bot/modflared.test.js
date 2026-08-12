'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isLocalHost,
  splitHostPort,
  parseTunnelTxt,
  lookupTunnelHostname,
  openModflaredTunnel,
  edgeWsUrl,
  accessHeaders,
  tunnelAlive,
  describeTunnel,
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

test('edgeWsUrl', () => {
  assert.equal(edgeWsUrl('play.bothome.site'), 'wss://play.bothome.site/');
});

test('accessHeaders always has UA', () => {
  const h = accessHeaders();
  assert.match(h['User-Agent'], /modflared/);
});

test('openModflaredTunnel on + loopback needs tunnel-host', async () => {
  await assert.rejects(
    () => openModflaredTunnel({ host: '127.0.0.1', port: 25565, mode: 'on' }),
    /forced_tunnels|public hostname/
  );
});

test('tunnelAlive prefers alive getter (embedded child:null)', () => {
  let live = true;
  const embedded = {
    child: null,
    tunnelHost: 'play.example.net',
    localHost: '127.0.0.1',
    localPort: 41234,
    backend: 'embedded',
    get alive() {
      return live;
    },
  };
  assert.equal(tunnelAlive(embedded), true);
  assert.deepEqual(describeTunnel(embedded, '127.0.0.1', 41234), {
    via: 'modflared',
    backend: 'embedded',
    hostname: 'play.example.net',
    local: '127.0.0.1:41234',
  });
  live = false;
  assert.equal(tunnelAlive(embedded), false);
  assert.deepEqual(describeTunnel(embedded), { via: 'direct' });
});

test('tunnelAlive falls back to child process when no alive field', () => {
  const child = { exitCode: null, killed: false };
  const legacy = { child, tunnelHost: 'play.example.net', localHost: '127.0.0.1', localPort: 9 };
  assert.equal(tunnelAlive(legacy), true);
  assert.equal(describeTunnel(legacy, '127.0.0.1', 9).via, 'modflared');
  assert.equal(describeTunnel(legacy, '127.0.0.1', 9).backend, 'cloudflared');
  child.exitCode = 0;
  assert.equal(tunnelAlive(legacy), false);
  assert.equal(tunnelAlive(null), false);
  assert.deepEqual(describeTunnel(null), { via: 'direct' });
});
