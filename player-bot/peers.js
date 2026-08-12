'use strict';

const { isSpectator } = require('./presence');

/**
 * Last-known places of other players, heard in-world (chat / signs / sight).
 * Per body only — not a shared tracker.
 */

class PeerBook {
  constructor() {
    this.peers = Object.create(null);
  }

  keyOf(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    if (this.peers[want]) return want;
    return Object.keys(this.peers).find((k) => k.toLowerCase() === want) || want;
  }

  note(name, pos, source = 'chat') {
    if (!name || pos == null || pos.x == null || pos.z == null) return null;
    const key = this.keyOf(name);
    const y = pos.y == null || Number.isNaN(Number(pos.y)) ? null : Number(pos.y);
    this.peers[key] = {
      name: String(name),
      x: Number(pos.x),
      y,
      z: Number(pos.z),
      source,
      ts: Date.now(),
    };
    return this.peers[key];
  }

  get(name) {
    const key = this.keyOf(name);
    return this.peers[key] || null;
  }

  list() {
    const now = Date.now();
    return Object.values(this.peers).map((p) => ({
      ...p,
      age_s: Math.round((now - p.ts) / 1000),
    }));
  }

  observeVisible(bot) {
    if (!bot?.players) return;
    for (const name of Object.keys(bot.players)) {
      if (name === bot.username) continue;
      if (isSpectator(bot, name)) continue;
      const e = bot.players[name]?.entity;
      if (!e?.position) continue;
      this.note(name, e.position, 'sight');
    }
  }
}

module.exports = { PeerBook };
