'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Per-bot remembered places (Mindcraft !rememberHere / !goToRememberedPlace).
 * Local only — not a shared hub.
 */
class PlaceBook {
  constructor(botName, dir) {
    this.botName = botName;
    this.file = path.join(dir, `places-${botName}.json`);
    this.places = {};
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        this.places = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch {
      this.places = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.places, null, 2) + '\n');
    } catch (e) {
      const err = new Error(`place save failed: ${e.message}`);
      err.code = 'IO';
      throw err;
    }
  }

  keyOf(name) {
    const raw = String(name || '').trim();
    if (!raw) return null;
    if (Object.prototype.hasOwnProperty.call(this.places, raw)) return raw;
    const lower = raw.toLowerCase();
    return Object.keys(this.places).find((k) => k.toLowerCase() === lower) || null;
  }

  remember(name, pos, note = '') {
    const key = String(name || '').trim();
    if (!key) {
      const err = new Error('place name required');
      err.code = 'BAD_ARGS';
      throw err;
    }
    const existing = this.keyOf(key);
    const storeKey = existing || key;
    this.places[storeKey] = {
      x: Number(pos.x),
      y: Number(pos.y),
      z: Number(pos.z),
      note: note || '',
      updated_at: Date.now(),
    };
    this.save();
    return this.places[storeKey];
  }

  get(name) {
    const k = this.keyOf(name);
    return k ? this.places[k] : null;
  }

  list() {
    return { ...this.places };
  }

  forget(name) {
    const k = this.keyOf(name);
    if (!k) return false;
    delete this.places[k];
    this.save();
    return true;
  }
}

module.exports = { PlaceBook };
