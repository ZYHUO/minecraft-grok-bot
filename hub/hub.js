'use strict';

/**
 * LEGACY Control Hub — NOT the recommended play mode.
 *
 * Prefer decentralized: gbot Unix sockets + in-game chat (see ARCHITECTURE.md).
 * A hub tends to create an implicit chief and kills long-term emergence.
 *
 * Kept for experiments only. Listen: 127.0.0.1:3100
 */

const path = require('path');
const express = require('express');
const { Store } = require('./store');
const proxy = require('./proxy');

const HUB_HOST = process.env.HUB_HOST || '127.0.0.1';
const HUB_PORT = Number(process.env.HUB_PORT || 3100);
const SHARED =
  process.env.HUB_SHARED ||
  path.resolve(__dirname, '../shared/hub');
const PLAYER_HOST = process.env.MC_PLAYER_HOST || '127.0.0.1';
// Default port map: Player1→3001 … or use registry
const DEFAULT_BASE_PORT = Number(process.env.PLAYER_BASE_PORT || 3001);

const store = new Store(SHARED);
const app = express();
app.use(express.json({ limit: '256kb' }));

function agentId(req) {
  return (
    req.get('X-Agent-Id') ||
    req.get('x-agent-id') ||
    req.query.agent_id ||
    req.body?.agent_id ||
    req.body?.from ||
    null
  );
}

function resolvePlayerPort(player) {
  const reg = store.getRegistry();
  if (reg.players[player]?.port) return reg.players[player].port;
  // scan agents
  for (const a of Object.values(reg.agents)) {
    if (a.player === player && a.port) return a.port;
  }
  // convention: name ends with digits → base+offset-1, else null
  return null;
}

function requireAgent(req, res) {
  const id = agentId(req);
  if (!id) {
    res.status(400).json({
      error: 'BAD_ARGS',
      message: 'Provide X-Agent-Id header (or agent_id). Register first: POST /agents/register',
    });
    return null;
  }
  return id;
}

// ---------- meta ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'grok-minecraft-hub',
    port: HUB_PORT,
    shared: SHARED,
    agents: store.listAgents().length,
    uptime_s: Math.floor(process.uptime()),
  });
});

app.get('/', (_req, res) => {
  res.json({
    service: 'grok-minecraft-hub',
    docs: [
      'POST /agents/register',
      'GET  /agents',
      'POST /agents/heartbeat',
      'GET  /players  |  /players/:name/status  |  POST .../action',
      'GET  /me/status  POST /me/action  (needs X-Agent-Id)',
      'POST /mail/send  GET /mail/inbox  POST /mail/ack',
      'POST /channels/:name/publish  GET /channels/:name',
      'GET  /board  PUT /board/:key  DELETE /board/:key',
      'GET  /team/status  GET /events',
    ],
    tip: 'Also use CLI: ./mcctl help',
  });
});

// ---------- agents ----------
app.post('/agents/register', (req, res) => {
  try {
    const body = req.body || {};
    const agent_id = body.agent_id || body.id || agentId(req);
    if (!agent_id) {
      return res.status(400).json({ error: 'BAD_ARGS', message: 'agent_id required' });
    }
    let port = body.port;
    if (port == null && body.player) {
      // auto-assign port if player like "Bot3" or sequential registration
      const existing = store.getPlayerBinding(body.player);
      port = existing?.port || body.port;
    }
    const entry = store.registerAgent({
      agent_id,
      player: body.player || body.bot || null,
      role: body.role || 'worker',
      port: port != null ? Number(port) : null,
      meta: body.meta || {},
    });
    res.json({ ok: true, agent: entry });
  } catch (e) {
    res.status(400).json({ error: e.code || 'ERROR', message: e.message });
  }
});

app.get('/agents', (_req, res) => {
  res.json({ agents: store.listAgents() });
});

app.get('/agents/:id', (req, res) => {
  const a = store.getAgent(req.params.id);
  if (!a) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ agent: { ...a, online: Date.now() - a.last_seen < 120000 } });
});

app.post('/agents/heartbeat', (req, res) => {
  const id = requireAgent(req, res);
  if (!id) return;
  const a = store.heartbeat(id);
  if (!a) return res.status(404).json({ error: 'NOT_FOUND', message: 'register first' });
  res.json({ ok: true, agent: a });
});

// ---------- mail (Grok ↔ Grok) ----------
app.post('/mail/send', (req, res) => {
  try {
    const body = req.body || {};
    const from = body.from || agentId(req) || 'anonymous';
    const msg = store.sendMail({
      from,
      to: body.to,
      channel: body.channel,
      subject: body.subject,
      body: body.body || body.text || body.message,
      payload: body.payload,
      type: body.type,
    });
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(e.code === 'BAD_ARGS' ? 400 : 500).json({ error: e.code || 'ERROR', message: e.message });
  }
});

app.get('/mail/inbox', (req, res) => {
  const id = req.query.agent || requireAgent(req, res);
  if (!id) return;
  store.heartbeat(id);
  const result = store.inbox(id, {
    since: req.query.since,
    limit: req.query.limit,
    unacked_only: req.query.unacked === '1' || req.query.unacked === 'true',
  });
  res.json({ agent: id, ...result });
});

app.post('/mail/ack', (req, res) => {
  const id = req.body?.agent || requireAgent(req, res);
  if (!id) return;
  const ids = req.body?.ids || (req.body?.id ? [req.body.id] : []);
  res.json({ ok: true, ...store.ackMail(id, ids) });
});

// ---------- channels ----------
app.post('/channels/:name/publish', (req, res) => {
  try {
    const from = req.body?.from || agentId(req) || 'anonymous';
    const msg = store.sendMail({
      from,
      channel: req.params.name,
      to: req.body?.to || null,
      subject: req.body?.subject,
      body: req.body?.body || req.body?.text || req.body?.message,
      payload: req.body?.payload,
      type: req.body?.type || 'channel',
    });
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(400).json({ error: e.code || 'ERROR', message: e.message });
  }
});

app.get('/channels/:name', (req, res) => {
  const result = store.channelHistory(req.params.name, {
    since: req.query.since,
    limit: req.query.limit || 50,
  });
  res.json({ channel: req.params.name, ...result });
});

// ---------- blackboard ----------
app.get('/board', (_req, res) => {
  res.json(store.getBoard());
});

app.get('/board/:key', (req, res) => {
  const v = store.getBoardKey(req.params.key);
  if (!v) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ key: req.params.key, ...v });
});

app.put('/board/:key', (req, res) => {
  const by = req.body?.by || agentId(req);
  const value = req.body?.value !== undefined ? req.body.value : req.body;
  const entry = store.setBoardKey(req.params.key, value, by);
  res.json({ ok: true, key: req.params.key, ...entry });
});

app.delete('/board/:key', (req, res) => {
  store.deleteBoardKey(req.params.key);
  res.json({ ok: true });
});

// ---------- player proxy ----------
app.get('/players', async (_req, res) => {
  const reg = store.getRegistry();
  const list = [];
  const seen = new Set();
  for (const p of Object.values(reg.players)) {
    seen.add(p.name);
    let health = null;
    if (p.port) {
      try {
        const r = await proxy.playerHealth(p.port, PLAYER_HOST);
        health = r.data;
      } catch (e) {
        health = { ok: false, error: e.message };
      }
    }
    list.push({ ...p, health });
  }
  res.json({ players: list });
});

async function withPlayerPort(name, res) {
  const port = resolvePlayerPort(name);
  if (!port) {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: `No port registered for player ${name}. Register with player+port or start-player.sh`,
    });
    return null;
  }
  return port;
}

app.get('/players/:name/status', async (req, res) => {
  const port = await withPlayerPort(req.params.name, res);
  if (!port) return;
  try {
    const r = await proxy.playerStatus(port, PLAYER_HOST, req.query.detail);
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

app.get('/players/:name/job', async (req, res) => {
  const port = await withPlayerPort(req.params.name, res);
  if (!port) return;
  try {
    const r = await proxy.playerJob(port, PLAYER_HOST);
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

app.post('/players/:name/action', async (req, res) => {
  const port = await withPlayerPort(req.params.name, res);
  if (!port) return;
  const from = agentId(req);
  try {
    const r = await proxy.playerAction(port, PLAYER_HOST, req.body || {});
    store.emit('action', {
      player: req.params.name,
      agent_id: from,
      type: req.body?.type,
      status: r.status,
    });
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

app.post('/players/:name/stop', async (req, res) => {
  const port = await withPlayerPort(req.params.name, res);
  if (!port) return;
  try {
    const r = await proxy.playerStop(port, PLAYER_HOST);
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

// ---------- me (bound agent → player) ----------
function boundPlayer(req, res) {
  const id = requireAgent(req, res);
  if (!id) return null;
  const a = store.getAgent(id);
  if (!a?.player) {
    res.status(400).json({
      error: 'BAD_ARGS',
      message: `Agent ${id} has no player binding. POST /agents/register {agent_id, player, port, role}`,
    });
    return null;
  }
  store.heartbeat(id);
  return a;
}

app.get('/me/status', async (req, res) => {
  const a = boundPlayer(req, res);
  if (!a) return;
  const port = a.port || resolvePlayerPort(a.player);
  if (!port) return res.status(404).json({ error: 'NOT_FOUND', message: 'no port' });
  try {
    const r = await proxy.playerStatus(port, PLAYER_HOST, req.query.detail);
    res.status(r.status).json({ agent_id: a.agent_id, role: a.role, ...r.data });
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

app.post('/me/action', async (req, res) => {
  const a = boundPlayer(req, res);
  if (!a) return;
  const port = a.port || resolvePlayerPort(a.player);
  if (!port) return res.status(404).json({ error: 'NOT_FOUND', message: 'no port' });
  try {
    const r = await proxy.playerAction(port, PLAYER_HOST, req.body || {});
    store.emit('action', { player: a.player, agent_id: a.agent_id, type: req.body?.type, status: r.status });
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

app.post('/me/stop', async (req, res) => {
  const a = boundPlayer(req, res);
  if (!a) return;
  const port = a.port || resolvePlayerPort(a.player);
  if (!port) return res.status(404).json({ error: 'NOT_FOUND', message: 'no port' });
  try {
    const r = await proxy.playerStop(port, PLAYER_HOST);
    res.status(r.status).json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'UPSTREAM', message: e.message });
  }
});

app.get('/me/inbox', (req, res) => {
  const id = requireAgent(req, res);
  if (!id) return;
  store.heartbeat(id);
  res.json({ agent: id, ...store.inbox(id, { since: req.query.since, limit: req.query.limit, unacked_only: req.query.unacked === '1' }) });
});

// ---------- team aggregate ----------
app.get('/team/status', async (_req, res) => {
  const agents = store.listAgents();
  const board = store.getBoard();
  const players = [];
  for (const a of agents) {
    if (!a.player || !a.port) {
      players.push({ agent_id: a.agent_id, player: a.player, role: a.role, online_agent: a.online, connected: false });
      continue;
    }
    try {
      const r = await proxy.playerStatus(a.port, PLAYER_HOST);
      const d = r.data || {};
      players.push({
        agent_id: a.agent_id,
        player: a.player,
        role: a.role,
        online_agent: a.online,
        connected: d.connected,
        pos: d.pos,
        health: d.health,
        food: d.food,
        job: d.job,
        danger: d.danger,
      });
    } catch (e) {
      players.push({
        agent_id: a.agent_id,
        player: a.player,
        role: a.role,
        online_agent: a.online,
        connected: false,
        error: e.message,
      });
    }
  }
  res.json({
    ts: Date.now(),
    count: players.length,
    board_keys: Object.keys(board.keys || {}),
    players,
  });
});

// ---------- events ----------
app.get('/events', (req, res) => {
  res.json(store.events({ since: req.query.since, limit: req.query.limit }));
});

// ---------- bulk register helper for teams ----------
app.post('/team/register_many', (req, res) => {
  const list = req.body?.agents || req.body || [];
  if (!Array.isArray(list)) {
    return res.status(400).json({ error: 'BAD_ARGS', message: 'expect { agents: [...] }' });
  }
  const out = [];
  list.forEach((item, i) => {
    const agent_id = item.agent_id || item.id || `agent${i + 1}`;
    const player = item.player || item.bot || agent_id;
    const port = item.port != null ? Number(item.port) : DEFAULT_BASE_PORT + i;
    out.push(
      store.registerAgent({
        agent_id,
        player,
        role: item.role || 'worker',
        port,
        meta: item.meta || {},
      })
    );
  });
  res.json({ ok: true, agents: out });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', hint: 'GET / for endpoint list' });
});

app.listen(HUB_PORT, HUB_HOST, () => {
  console.log(`[hub] http://${HUB_HOST}:${HUB_PORT}`);
  console.log(`[hub] shared store: ${SHARED}`);
  console.log(`[hub] register: curl -X POST http://${HUB_HOST}:${HUB_PORT}/agents/register -H 'Content-Type: application/json' -d '{"agent_id":"chief","player":"Chief1","port":3001,"role":"chief"}'`);
});
