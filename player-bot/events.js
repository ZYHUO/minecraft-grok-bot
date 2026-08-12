'use strict';

/**
 * Local event ring buffer — the only "inbox" is what this body saw in the world.
 * Other bots are not on a shared bus; they appear here via Minecraft chat/proximity.
 */
class EventLog {
  constructor(limit = 200) {
    this.limit = limit;
    this.items = [];
    this.seq = 0;
  }

  push(kind, data = {}) {
    this.seq += 1;
    const ev = {
      seq: this.seq,
      ts: Date.now(),
      kind,
      ...data,
    };
    this.items.push(ev);
    while (this.items.length > this.limit) this.items.shift();
    return ev;
  }

  since(seq = 0, limit = 50) {
    const s = Number(seq) || 0;
    const out = [];
    for (const it of this.items) {
      if (it.seq > s) out.push(it);
      if (out.length >= limit) break;
    }
    return {
      items: out,
      next_since: out.length ? out[out.length - 1].seq : s,
      latest: this.seq,
    };
  }
}

module.exports = { EventLog };
