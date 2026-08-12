'use strict';

/**
 * Modflared-compatible client for Mineflayer.
 * Fabric/Forge cannot load into Node. Same DNS TXT + in-process Access TCP (wss).
 */

const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
  );
}

function splitHostPort(raw, defaultPort) {
  const s = String(raw || '').trim();
  const m6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m6) return { host: m6[1], port: Number(m6[2] || defaultPort) };
  const idx = s.lastIndexOf(':');
  if (idx > 0 && s.indexOf(':') === idx && /^\d+$/.test(s.slice(idx + 1))) {
    return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  }
  return { host: s, port: Number(defaultPort) };
}

function parseTunnelTxt(records) {
  const flat = [];
  for (const rec of records || []) {
    if (Array.isArray(rec)) flat.push(rec.join(''));
    else if (typeof rec === 'string') flat.push(rec);
  }
  for (const raw of flat) {
    const t = String(raw).trim();
    if (t === 'cloudflared-use-tunnel') return { use: true, route: null };
    const m = t.match(/^cloudflared-route=(.+)$/i);
    if (m) return { use: true, route: m[1].trim() };
  }
  return { use: false, route: null };
}

async function lookupTunnelHostname(hostname, resolveTxt = dns.resolveTxt) {
  try {
    const recs = await resolveTxt(hostname);
    const parsed = parseTunnelTxt(recs);
    if (!parsed.use) return null;
    return parsed.route || hostname;
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA' || e.code === 'SERVFAIL') return null;
    throw e;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function waitListening(host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const c = net.connect({ host, port }, () => {
        c.end();
        resolve();
      });
      c.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`cloudflared not listening on ${host}:${port}`));
          return;
        }
        setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

function findCloudflared() {
  return process.env.CLOUDFLARED_BIN || 'cloudflared';
}

function accessHeaders() {
  const h = { 'User-Agent': 'minecraft-grok-bot/modflared' };
  const id = process.env.TUNNEL_SERVICE_TOKEN_ID || process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.TUNNEL_SERVICE_TOKEN_SECRET || process.env.CF_ACCESS_CLIENT_SECRET;
  if (id) h['Cf-Access-Client-Id'] = id;
  if (secret) h['Cf-Access-Client-Secret'] = secret;
  return h;
}

function edgeWsUrl(hostname) {
  return `wss://${hostname}/`;
}

function toBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data);
  return Buffer.from(data);
}

function openEdgeSocket(hostname) {
  if (typeof WebSocket !== 'function') {
    const err = new Error('Node WebSocket missing (need Node 22+)');
    err.code = 'TUNNEL';
    throw err;
  }
  const ws = new WebSocket(edgeWsUrl(hostname), { headers: accessHeaders() });
  return ws;
}

async function waitWsOpen(ws, timeoutMs) {
  if (ws.readyState === 1) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* */
      }
      reject(new Error(`edge websocket timeout for ${timeoutMs}ms`));
    }, timeoutMs);
    const onOpen = () => {
      clearTimeout(t);
      resolve();
    };
    const onErr = (ev) => {
      clearTimeout(t);
      reject(ev?.error || new Error(ev?.message || 'edge websocket error'));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onErr, { once: true });
  });
}

function pipeTcpToWs(sock, ws) {
  const flush = (data) => {
    if (ws.readyState !== 1) return;
    try {
      const buf = toBuf(data);
      ws.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch {
      /* */
    }
  };
  sock.on('data', flush);
  sock.on('end', () => {
    try {
      ws.close();
    } catch {
      /* */
    }
  });
  sock.on('error', () => {
    try {
      ws.close();
    } catch {
      /* */
    }
  });
  ws.addEventListener('message', (ev) => {
    const p = ev.data;
    if (p && typeof p.arrayBuffer === 'function' && !Buffer.isBuffer(p)) {
      p.arrayBuffer().then((ab) => {
        if (!sock.destroyed) sock.write(Buffer.from(ab));
      }).catch(() => {});
      return;
    }
    if (!sock.destroyed) sock.write(toBuf(p));
  });
  ws.addEventListener('close', () => {
    try {
      sock.end();
    } catch {
      /* */
    }
  });
  ws.addEventListener('error', () => {
    try {
      sock.destroy();
    } catch {
      /* */
    }
  });
}

/**
 * In-process Cloudflare Access TCP (same as `cloudflared access tcp`).
 * Local TCP listen → one wss://hostname WebSocket per Minecraft connection.
 */
async function openEmbeddedTunnel(tunnelHost, localHost, localPort, opts) {
  const log = opts.log || (() => {});
  const probe = openEdgeSocket(tunnelHost);
  try {
    await waitWsOpen(probe, Number(opts.readyTimeoutMs || 20000));
  } finally {
    try {
      probe.close();
    } catch {
      /* */
    }
  }
  log('modflared: embedded access tcp', tunnelHost, '->', `${localHost}:${localPort}`);

  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let ws;
    try {
      ws = openEdgeSocket(tunnelHost);
    } catch (e) {
      log('modflared: ws create failed', e.message);
      sock.destroy();
      return;
    }
    waitWsOpen(ws, Number(opts.readyTimeoutMs || 20000))
      .then(() => pipeTcpToWs(sock, ws))
      .catch((e) => {
        log('modflared: edge ws failed', e.message);
        try {
          sock.destroy();
        } catch {
          /* */
        }
      });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, localHost, resolve);
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* */
      }
    }
    sockets.clear();
    try {
      server.close();
    } catch {
      /* */
    }
  };

  return {
    localHost,
    localPort,
    tunnelHost,
    destHost: opts.destHost,
    child: null,
    stop,
    get alive() {
      return !stopped && server.listening;
    },
  };
}

/**
 * @returns {Promise<null | { localHost, localPort, tunnelHost, child, stop }>}
 */
async function openModflaredTunnel(opts) {
  const log = opts.log || (() => {});
  const mode = String(opts.mode || 'auto').toLowerCase();
  const dest = splitHostPort(opts.host, opts.port || 25565);
  const forced = String(opts.forcedHost || '').trim();

  if (mode === 'off') return null;
  if (mode === 'auto' && !forced && isLocalHost(dest.host)) return null;
  if (mode === 'on' && !forced && isLocalHost(dest.host)) {
    const err = new Error(
      'MC_TUNNEL=on needs a public hostname or --tunnel-host (same as Modflared forced_tunnels.json)'
    );
    err.code = 'TUNNEL';
    throw err;
  }

  let tunnelHost = forced || dest.host;
  if (mode === 'auto' && !forced) {
    const discovered = await lookupTunnelHostname(dest.host);
    if (!discovered) return null;
    tunnelHost = discovered;
  }

  const localPort = opts.localPort || (await freePort());
  const localHost = '127.0.0.1';
  const backend = String(opts.backend || process.env.MC_TUNNEL_BACKEND || 'embedded').toLowerCase();
  if (backend !== 'cloudflared' && backend !== 'cli') {
    try {
      return await openEmbeddedTunnel(tunnelHost, localHost, localPort, {
        log,
        destHost: dest.host,
        readyTimeoutMs: opts.readyTimeoutMs,
      });
    } catch (e) {
      const err = new Error(`Modflared tunnel failed for ${tunnelHost}: ${e.message}`);
      err.code = 'TUNNEL';
      throw err;
    }
  }

  const bin = findCloudflared();
  const args = [
    'access',
    'tcp',
    '--hostname',
    tunnelHost,
    '--url',
    `${localHost}:${localPort}`,
  ];
  if (process.env.TUNNEL_SERVICE_TOKEN_ID) {
    args.push('--id', process.env.TUNNEL_SERVICE_TOKEN_ID);
  }
  if (process.env.TUNNEL_SERVICE_TOKEN_SECRET) {
    args.push('--secret', process.env.TUNNEL_SERVICE_TOKEN_SECRET);
  }

  log('modflared: starting cloudflared access tcp', tunnelHost, '->', `${localHost}:${localPort}`);
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b) => log('cloudflared', String(b).trim()));
  child.stderr?.on('data', (b) => log('cloudflared', String(b).trim()));

  let stopped = false;
  let spawnErr = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* */
    }
  };
  child.on('error', (e) => {
    spawnErr = e;
  });
  child.on('exit', (code) => {
    if (!stopped) log('cloudflared exited', code);
    stopped = true;
  });

  try {
    await Promise.race([
      waitListening(localHost, localPort, Number(opts.readyTimeoutMs || 20000)),
      new Promise((_, reject) => {
        child.once('error', reject);
      }),
    ]);
  } catch (e) {
    stop();
    const cause = spawnErr || e;
    const hint =
      cause.code === 'ENOENT'
        ? 'cloudflared not found. Install it or set CLOUDFLARED_BIN.'
        : cause.message;
    const err = new Error(`Modflared tunnel failed for ${tunnelHost}: ${hint}`);
    err.code = 'TUNNEL';
    throw err;
  }

  return {
    localHost,
    localPort,
    tunnelHost,
    destHost: dest.host,
    child,
    stop,
    get alive() {
      return !stopped && child.exitCode == null && !child.killed;
    },
  };
}

module.exports = {
  isLocalHost,
  splitHostPort,
  parseTunnelTxt,
  lookupTunnelHostname,
  accessHeaders,
  edgeWsUrl,
  openModflaredTunnel,
};
