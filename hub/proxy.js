'use strict';

/**
 * Lightweight HTTP client to talk to per-player Mineflayer controllers.
 */

async function request(base, method, p, body, timeoutMs = 15000) {
  const url = `${base.replace(/\/$/, '')}${p}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'upstream timeout' : e.message);
    err.code = e.name === 'AbortError' ? 'TIMEOUT' : 'UPSTREAM';
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function playerBase(port, host = '127.0.0.1') {
  return `http://${host}:${port}`;
}

async function playerHealth(port, host) {
  return request(playerBase(port, host), 'GET', '/health', undefined, 5000);
}

async function playerStatus(port, host, detail) {
  const q = detail ? `?detail=${encodeURIComponent(detail)}` : '';
  return request(playerBase(port, host), 'GET', `/status${q}`, undefined, 8000);
}

async function playerAction(port, host, body) {
  // Long actions return immediately from player-bot; keep moderate timeout
  return request(playerBase(port, host), 'POST', '/action', body, 20000);
}

async function playerStop(port, host) {
  return request(playerBase(port, host), 'POST', '/stop', {}, 10000);
}

async function playerJob(port, host) {
  return request(playerBase(port, host), 'GET', '/job', undefined, 5000);
}

module.exports = {
  request,
  playerBase,
  playerHealth,
  playerStatus,
  playerAction,
  playerStop,
  playerJob,
};
