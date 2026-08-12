'use strict';

/**
 * In-memory ring buffer of spectator events (chat / join / leave).
 * Same idea as player-bot/events.js — local only, no hub bus.
 */
class EventLog {
  constructor(limit = 300) {
    this.limit = limit;
    this.items = [];
    this.seq = 0;
    this.listeners = new Set();
  }

  push(kind, data = {}) {
    this.seq += 1;
    const ev = {
      id: this.seq,
      ts: Date.now(),
      kind,
      ...data,
    };
    this.items.push(ev);
    while (this.items.length > this.limit) this.items.shift();
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* ignore listener errors */
      }
    }
    return ev;
  }

  recent(limit = 100) {
    const n = Math.min(Number(limit) || 100, this.items.length);
    return this.items.slice(-n);
  }

  since(id = 0, limit = 100) {
    const s = Number(id) || 0;
    const out = [];
    for (const it of this.items) {
      if (it.id > s) out.push(it);
      if (out.length >= limit) break;
    }
    return {
      items: out,
      next_since: out.length ? out[out.length - 1].id : s,
      latest: this.seq,
    };
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { EventLog };
