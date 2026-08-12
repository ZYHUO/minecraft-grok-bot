'use strict';

/**
 * File-backed store for multi-Grok-Bot coordination.
 * Survives hub restarts; agents can also read files directly under shared/hub/.
 */

const fs = require('fs');
const path = require('path');

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function appendLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file, { since = 0, limit = 100, filter } = {}) {
  if (!fs.existsSync(file)) return { items: [], next_since: since };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { items: [], next_since: since };
  const lines = text.split('\n').filter(Boolean);
  const items = [];
  let idx = 0;
  for (const line of lines) {
    idx += 1;
    if (idx <= since) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    obj._seq = idx;
    if (filter && !filter(obj)) continue;
    items.push(obj);
    if (items.length >= limit) break;
  }
  const next = items.length ? items[items.length - 1]._seq : since;
  return { items, next_since: next, total_lines: lines.length };
}

class Store {
  /**
   * @param {string} root  shared/hub directory
   */
  constructor(root) {
    this.root = root;
    this.registryFile = path.join(root, 'registry.json');
    this.boardFile = path.join(root, 'blackboard.json');
    this.eventsFile = path.join(root, 'events.ndjson');
    this.mailboxDir = path.join(root, 'mailbox');
    this.channelsDir = path.join(root, 'channels');
    ensureDir(this.root);
    ensureDir(this.mailboxDir);
    ensureDir(this.channelsDir);
    if (!fs.existsSync(this.registryFile)) writeJsonAtomic(this.registryFile, { agents: {}, players: {} });
    if (!fs.existsSync(this.boardFile)) writeJsonAtomic(this.boardFile, { keys: {} });
  }

  // ----- registry -----
  getRegistry() {
    return readJson(this.registryFile, { agents: {}, players: {} });
  }

  saveRegistry(reg) {
    writeJsonAtomic(this.registryFile, reg);
  }

  /**
   * Register or refresh an agent (a Grok Bot session identity).
   */
  registerAgent({ agent_id, player, role, port, meta }) {
    if (!agent_id) throw Object.assign(new Error('agent_id required'), { code: 'BAD_ARGS' });
    const reg = this.getRegistry();
    const now = Date.now();
    const prev = reg.agents[agent_id] || {};
    const entry = {
      agent_id,
      player: player || prev.player || null,
      role: role || prev.role || 'worker',
      port: port != null ? Number(port) : prev.port || null,
      meta: meta || prev.meta || {},
      registered_at: prev.registered_at || now,
      last_seen: now,
    };
    reg.agents[agent_id] = entry;
    if (entry.player) {
      reg.players[entry.player] = {
        name: entry.player,
        port: entry.port,
        agent_id,
        role: entry.role,
        last_seen: now,
      };
    }
    this.saveRegistry(reg);
    this.emit('agent_register', { agent_id, player: entry.player, role: entry.role, port: entry.port });
    return entry;
  }

  heartbeat(agent_id) {
    const reg = this.getRegistry();
    if (!reg.agents[agent_id]) return null;
    reg.agents[agent_id].last_seen = Date.now();
    this.saveRegistry(reg);
    return reg.agents[agent_id];
  }

  listAgents({ stale_ms = 120000 } = {}) {
    const reg = this.getRegistry();
    const now = Date.now();
    return Object.values(reg.agents).map((a) => ({
      ...a,
      online: now - (a.last_seen || 0) < stale_ms,
    }));
  }

  getAgent(agent_id) {
    return this.getRegistry().agents[agent_id] || null;
  }

  getPlayerBinding(player) {
    return this.getRegistry().players[player] || null;
  }

  // ----- mail -----
  mailboxPath(agent_id) {
    // sanitize
    const safe = String(agent_id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.mailboxDir, `${safe}.jsonl`);
  }

  sendMail({ from, to, channel, subject, body, payload, type }) {
    const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const msg = {
      id,
      ts: Date.now(),
      from: from || 'anonymous',
      to: to || null,
      channel: channel || null,
      type: type || 'message',
      subject: subject || '',
      body: body || '',
      payload: payload !== undefined ? payload : null,
      acked: false,
    };

    if (channel) {
      appendLine(path.join(this.channelsDir, `${String(channel).replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`), msg);
      this.emit('channel', { channel, id, from: msg.from });
    }

    if (to) {
      if (to === '*' || to === 'all') {
        // fan-out to every registered agent except sender
        for (const a of this.listAgents()) {
          if (a.agent_id === from) continue;
          appendLine(this.mailboxPath(a.agent_id), { ...msg, to: a.agent_id });
        }
      } else {
        appendLine(this.mailboxPath(to), msg);
      }
      this.emit('mail', { to, id, from: msg.from });
    }

    if (!to && !channel) {
      throw Object.assign(new Error('mail requires to and/or channel'), { code: 'BAD_ARGS' });
    }

    // also global event log for tail
    appendLine(this.eventsFile, { kind: 'mail', ...msg });
    return msg;
  }

  inbox(agent_id, { since = 0, limit = 50, unacked_only = false } = {}) {
    return readJsonl(this.mailboxPath(agent_id), {
      since: Number(since) || 0,
      limit: Math.min(200, Number(limit) || 50),
      filter: unacked_only ? (m) => !m.acked : undefined,
    });
  }

  ackMail(agent_id, ids) {
    const file = this.mailboxPath(agent_id);
    if (!fs.existsSync(file)) return { acked: 0 };
    const idSet = new Set(ids || []);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let acked = 0;
    const out = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const o = JSON.parse(line);
        if (idSet.has(o.id) && !o.acked) {
          o.acked = true;
          o.acked_at = Date.now();
          acked += 1;
          return JSON.stringify(o);
        }
      } catch {
        /* keep */
      }
      return line;
    });
    fs.writeFileSync(file, out.filter((l, i) => l || i < out.length - 1).join('\n') + (out.length ? '\n' : ''));
    return { acked };
  }

  channelHistory(channel, opts) {
    const safe = String(channel).replace(/[^a-zA-Z0-9._-]/g, '_');
    return readJsonl(path.join(this.channelsDir, `${safe}.jsonl`), opts);
  }

  // ----- blackboard -----
  getBoard() {
    return readJson(this.boardFile, { keys: {} });
  }

  getBoardKey(key) {
    const b = this.getBoard();
    return b.keys[key] || null;
  }

  setBoardKey(key, value, by) {
    const b = this.getBoard();
    b.keys[key] = {
      value,
      by: by || null,
      updated_at: Date.now(),
    };
    writeJsonAtomic(this.boardFile, b);
    this.emit('board', { key, by });
    appendLine(this.eventsFile, { kind: 'board', key, by, ts: Date.now(), value });
    return b.keys[key];
  }

  deleteBoardKey(key) {
    const b = this.getBoard();
    delete b.keys[key];
    writeJsonAtomic(this.boardFile, b);
    this.emit('board_delete', { key });
    return true;
  }

  // ----- events -----
  emit(kind, data) {
    appendLine(this.eventsFile, { kind, ts: Date.now(), ...data });
  }

  events({ since = 0, limit = 100 } = {}) {
    return readJsonl(this.eventsFile, { since: Number(since) || 0, limit: Math.min(500, Number(limit) || 100) });
  }
}

module.exports = { Store, readJson, writeJsonAtomic, appendLine, readJsonl };
