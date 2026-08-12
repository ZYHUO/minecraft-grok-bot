'use strict';

/**
 * Mindcraft-inspired background modes.
 * They keep the body alive / slightly alive when Grok is not micro-managing.
 * They never assign work to other bots.
 */

const { isHostileName, isHuntableName, timeOfDay } = require('./mcdata');
const { findShelterLight, emote, blockLightLevel } = require('./presence');

function rand() {
  return Math.random();
}

class ModeRunner {
  /**
   * @param {object} opts
   * @param {() => any} opts.getBot
   * @param {object} opts.soul
   * @param {object} opts.config
   * @param {(kind, data) => void} opts.emit
   * @param {() => boolean} opts.isBusy  true if a Grok job is running
   * @param {(body) => Promise<any>} opts.runAction  executeAction wrapper
   */
  constructor(opts) {
    this.getBot = opts.getBot;
    this.soul = opts.soul;
    this.config = opts.config;
    this.emit = opts.emit;
    this.isBusy = opts.isBusy;
    this.runAction = opts.runAction;
    this.abortJob = opts.abortJob || (async () => {});
    this.stopMotors = opts.stopMotors || (async () => {});

    this._timer = null;
    this._tickRunning = false;
    this._stuck = { pos: null, since: 0 };
    this._lastGreet = new Map(); // name -> ts
    this._lastPickup = 0;
    this._lastTorch = 0;
    this._lastShelter = 0;
    this._holdingShelter = false;
    this._goal = null; // soft local goal string from Grok
    this.enabled = true;
  }

  setSoul(soul) {
    this.soul = soul;
  }

  setGoal(text) {
    this._goal = text || null;
    this.emit('goal', { text: this._goal });
  }

  getGoal() {
    return this._goal;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._tickRunning) return;
      this._tickRunning = true;
      this.tick()
        .catch(() => {})
        .finally(() => {
          this._tickRunning = false;
        });
    }, 1500);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (!this.enabled) return;
    const bot = this.getBot();
    if (!bot?.entity) return;
    const modes = this.soul.modes || {};

    // Hard survival always can interrupt when enabled (even if Grok is busy)
    if (modes.self_preservation !== false) {
      const handled = await this.selfPreservation(bot);
      if (handled) return;
    }

    if (modes.self_defense) {
      const d = await this.selfDefense(bot);
      if (d) return;
    } else if (modes.cowardice) {
      const c = await this.cowardice(bot);
      if (c) return;
    }

    if (this.isBusy()) return; // Grok is driving (non-critical modes only)

    if (modes.unstuck !== false) {
      const u = await this.unstuck(bot);
      if (u) return;
    }

    if (modes.seek_light !== false) {
      const sh = await this.seekLight(bot);
      if (sh) return;
    }

    if (modes.item_collecting) {
      await this.itemCollecting(bot);
    }

    if (modes.torch_placing) {
      await this.torchPlacing(bot);
    }

    if (modes.hunting) {
      const h = await this.hunting(bot);
      if (h) return;
    }

    if (modes.social !== false) {
      await this.social(bot);
    }

    if (modes.curiosity !== false) {
      await this.curiosity(bot);
    }
  }

  async selfPreservation(bot) {
    const block = bot.blockAt(bot.entity.position);
    const above = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    const bname = block?.name || 'air';
    const aname = above?.name || 'air';

    if (aname === 'water' || bname === 'water') {
      bot.setControlState('jump', true);
      setTimeout(() => {
        try {
          bot.setControlState('jump', false);
        } catch {
          /* */
        }
      }, 400);
      return false; // non-blocking
    }

    if (
      bname === 'lava' ||
      bname === 'fire' ||
      aname === 'lava' ||
      aname === 'fire' ||
      bot.entity.isInLava
    ) {
      this.emit('mode', { name: 'self_preservation', detail: 'lava_or_fire' });
      try {
        bot.chat('烫烫烫！');
      } catch {
        /* */
      }
      // Drop Grok path so pathfinder cannot walk us back into lava
      try {
        await this.abortJob('lava');
      } catch {
        /* */
      }
      try {
        await this.stopMotors();
      } catch {
        /* */
      }
      try {
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        await new Promise((r) => setTimeout(r, 1200));
      } catch {
        /* */
      }
      return true;
    }

    if (bot.health !== undefined && bot.health <= 5) {
      this.emit('mode', { name: 'self_preservation', detail: 'low_health', health: bot.health });
      try {
        await this.abortJob('low_health');
      } catch {
        /* */
      }
      try {
        await this.stopMotors();
      } catch {
        /* */
      }
      try {
        await this.eatAnything(bot);
      } catch {
        /* */
      }
      try {
        bot.chat('血好少…先撤');
      } catch {
        /* */
      }
      // Direct keys — pathfinder would fight an in-flight aborted skill
      try {
        bot.setControlState('sprint', true);
        bot.setControlState('back', true);
        bot.setControlState('jump', true);
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        /* */
      }
      return true;
    }
    return false;
  }

  async eatAnything(bot) {
    const foods = bot.registry?.foodsByName || {};
    const item = (bot.inventory?.items() || [])
      .filter((i) => foods[i.name])
      .sort((a, b) => (foods[b.name]?.foodPoints || 0) - (foods[a.name]?.foodPoints || 0))[0];
    if (!item || typeof bot.consume !== 'function') return false;
    await bot.equip(item, 'hand');
    await bot.consume();
    return true;
  }

  nearestMob(bot, pred, range) {
    let best = null;
    let bestD = Infinity;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e?.position || e === bot.entity || e.type === 'player') continue;
      const n = (e.name || '').toLowerCase();
      if (!pred(n)) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < bestD && d <= range) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  async fleeFrom(bot, entity, dist) {
    const away = bot.entity.position.minus(entity.position).normalize();
    const t = bot.entity.position.plus(away.scaled(dist));
    try {
      await this.abortJob('flee');
    } catch {
      /* */
    }
    try {
      await this.stopMotors();
    } catch {
      /* */
    }
    try {
      await this.runAction({
        type: 'move_to',
        x: t.x,
        y: t.y,
        z: t.z,
        range: 2,
        timeout_ms: 6000,
      });
    } catch {
      bot.setControlState('sprint', true);
      bot.setControlState('back', true);
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  async cowardice(bot) {
    const mob = this.nearestMob(bot, isHostileName, 16);
    if (!mob) return false;
    this.emit('mode', { name: 'cowardice', detail: mob.name });
    await this.fleeFrom(bot, mob, 20);
    return true;
  }

  async selfDefense(bot) {
    const mob = this.nearestMob(bot, isHostileName, 8);
    if (!mob) return false;
    this.emit('mode', { name: 'self_defense', detail: mob.name });
    try {
      await this.runAction({ type: 'attack', name: mob.name, entity_id: mob.id });
    } catch {
      /* */
    }
    return true;
  }

  async hunting(bot) {
    const mob = this.nearestMob(bot, isHuntableName, 12);
    if (!mob) return false;
    this.emit('mode', { name: 'hunting', detail: mob.name });
    try {
      await this.runAction({ type: 'attack', name: mob.name, entity_id: mob.id });
    } catch {
      /* */
    }
    return true;
  }

  async itemCollecting(bot) {
    const now = Date.now();
    if (now - this._lastPickup < 4000) return false;
    let item = null;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (e?.name === 'item' && e.position && bot.entity.position.distanceTo(e.position) < 6) {
        item = e;
        break;
      }
    }
    if (!item) return false;
    this._lastPickup = now;
    this.emit('mode', { name: 'item_collecting' });
    try {
      await this.runAction({
        type: 'move_to',
        x: item.position.x,
        y: item.position.y,
        z: item.position.z,
        range: 1,
        timeout_ms: 8000,
      });
    } catch {
      /* */
    }
    return true;
  }

  async torchPlacing(bot) {
    const now = Date.now();
    if (now - this._lastTorch < 8000) return false;
    const torch = (bot.inventory?.items() || []).find((i) => i.name.includes('torch'));
    if (!torch) return false;
    const here = bot.blockAt(bot.entity.position);
    const light = here?.light ?? here?.skyLight ?? 15;
    if (light > 7) return false;
    const near = bot.findBlock({
      matching: (b) => b && String(b.name).includes('torch'),
      maxDistance: 6,
    });
    if (near) return false;
    this._lastTorch = now;
    this.emit('mode', { name: 'torch_placing' });
    try {
      const p = bot.entity.position.floored();
      await this.runAction({ type: 'place', item: torch.name, x: p.x, y: p.y, z: p.z });
    } catch {
      /* */
    }
    return true;
  }

  async unstuck(bot) {
    const p = bot.entity.position;
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    const now = Date.now();
    if (!this._stuck.pos || this._stuck.pos !== key) {
      this._stuck = { pos: key, since: now };
      return false;
    }
    if (now - this._stuck.since < 12000) return false;

    this.emit('mode', { name: 'unstuck', detail: 'same_block_12s' });
    this._stuck.since = now;
    try {
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      await new Promise((r) => setTimeout(r, 600));
      bot.clearControlStates();
    } catch {
      /* */
    }
    return true;
  }

  async social(bot) {
    const idle = this.soul.idle || {};
    if (!idle.stare_players && !idle.greet_chance) return;

    // nearest other player
    let best = null;
    let bestD = Infinity;
    for (const name of Object.keys(bot.players)) {
      if (name === bot.username) continue;
      const e = bot.players[name]?.entity;
      if (!e?.position) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d < bestD) {
        bestD = d;
        best = { name, e };
      }
    }
    if (!best || bestD > 12) return;

    if (idle.stare_players) {
      try {
        await bot.lookAt(best.e.position.offset(0, best.e.height * 0.8, 0), true);
      } catch {
        /* */
      }
    }

    const greetChance = idle.greet_chance ?? 0.1;
    const last = this._lastGreet.get(best.name) || 0;
    if (Date.now() - last > 120000 && rand() < greetChance) {
      this._lastGreet.set(best.name, Date.now());
      try {
        await emote(bot, 'jump', { target: best.e.position });
      } catch {
        /* */
      }
      const line =
        this.soul.greeting ||
        `嗨 ${best.name}`;
      try {
        await this.runAction({ type: 'chat', message: line });
        this.emit('mode', { name: 'social', detail: 'greet', target: best.name });
      } catch {
        /* */
      }
    }
  }

  async seekLight(bot) {
    const now = Date.now();
    if (now - this._lastShelter < 8000) return false;
    const tod = timeOfDay(bot);
    const night = tod === 'night' || tod === 'midnight';
    const rain = Boolean(bot.isRaining);
    if (!night && !rain) {
      this._holdingShelter = false;
      return false;
    }
    const here = bot.blockAt(bot.entity.position);
    const light = blockLightLevel(here);
    if (light >= 9) {
      this._holdingShelter = true;
      return false;
    }
    this._holdingShelter = false;
    const lamp = findShelterLight(bot, 24);
    if (!lamp) return false;
    this._lastShelter = now;
    this.emit('mode', {
      name: 'seek_light',
      detail: rain ? 'rain' : 'night',
      to: lamp.name,
    });
    try {
      await this.runAction({
        type: 'move_to',
        x: lamp.position.x,
        y: lamp.position.y,
        z: lamp.position.z,
        range: 3,
        timeout_ms: 12000,
      });
    } catch {
      /* */
    }
    return true;
  }

  async curiosity(bot) {
    const idle = this.soul.idle || {};
    if (this._holdingShelter) return;
    const chance = idle.wander_chance ?? 0.05;
    if (rand() > chance) return;
    const r = idle.wander_radius ?? 10;
    const dx = (rand() - 0.5) * 2 * r;
    const dz = (rand() - 0.5) * 2 * r;
    const t = bot.entity.position.offset(dx, 0, dz);
    if (this.isBusy()) return;
    this.emit('mode', { name: 'curiosity', detail: 'wander', to: { x: t.x, y: t.y, z: t.z } });
    try {
      await this.runAction({
        type: 'move_to',
        x: t.x,
        y: t.y,
        z: t.z,
        range: 2,
        timeout_ms: 15000,
      });
    } catch {
      /* path fail / busy ok */
    }
  }
}

module.exports = { ModeRunner };
