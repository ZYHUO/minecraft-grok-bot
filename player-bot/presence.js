'use strict';

const { Vec3 } = require('vec3');
const { Movements } = require('mineflayer-pathfinder');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function gaitOf(soul) {
  const g = soul?.gait || {};
  const style = g.style || 'amble';
  return {
    style,
    sprint: g.sprint ?? style === 'sprint',
    sneak_near: Number(g.sneak_near ?? (style === 'sneak' ? 10 : 0)),
    pause_chance: Number(g.pause_chance ?? (style === 'amble' ? 0.2 : style === 'sprint' ? 0.04 : 0.1)),
    look_interval_ms: Number(g.look_interval_ms ?? (style === 'sprint' ? 3600 : 2200)),
    greet_jump: g.greet_jump !== false,
  };
}

function applyGait(bot, soul, distToTarget = Infinity) {
  const g = gaitOf(soul);
  const near = g.sneak_near > 0 && distToTarget <= g.sneak_near;
  const key = `${g.style}:${Boolean(g.sprint)}:${near}`;
  if (bot._gaitKey === key) return { ...g, near };
  bot._gaitKey = key;
  try {
    if (bot.pathfinder) {
      const movements = new Movements(bot);
      movements.allowSprinting = Boolean(g.sprint) && !near;
      movements.canDig = true;
      bot.pathfinder.setMovements(movements);
    }
  } catch {
    /* */
  }
  try {
    bot.setControlState('sneak', near);
    if (!near) bot.setControlState('sprint', Boolean(g.sprint));
    else bot.setControlState('sprint', false);
  } catch {
    /* */
  }
  return { ...g, near };
}

class WorldSense {
  constructor() {
    this.pending = [];
    this.traces = [];
  }

  push(kind, data = {}) {
    const now = Date.now();
    const last = this.pending[this.pending.length - 1];
    if (last && last.kind === kind && now - last.ts < 1500) {
      if (data.voiced) last.voiced = true;
      return last;
    }
    const ev = { kind, ts: now, voiced: Boolean(data.voiced), ...data };
    this.pending.push(ev);
    while (this.pending.length > 24) this.pending.shift();
    return ev;
  }

  take(maxAgeMs = 10000) {
    const now = Date.now();
    const out = this.pending.filter((e) => !e.voiced && now - e.ts <= maxAgeMs);
    this.pending = [];
    return out;
  }

  noteTrace(kind, pos) {
    if (!pos) return;
    this.traces.push({
      kind,
      x: Number(pos.x),
      y: Number(pos.y),
      z: Number(pos.z),
      ts: Date.now(),
    });
    const cut = Date.now() - 120000;
    this.traces = this.traces.filter((t) => t.ts > cut).slice(-80);
  }

  pickTrace(bot, dest) {
    if (!bot?.entity || !dest) return null;
    const me = bot.entity.position;
    const destV = new Vec3(dest.x, dest.y ?? me.y, dest.z);
    const remain = me.distanceTo(destV);
    let best = null;
    let bestScore = 0;
    for (const t of this.traces) {
      const p = new Vec3(t.x, t.y, t.z);
      const toMe = me.distanceTo(p);
      const toDest = p.distanceTo(destV);
      if (toMe < 1.4 || toMe > 22) continue;
      if (toDest >= remain - 0.5) continue;
      const score = (t.kind === 'torch' ? 2.2 : t.kind === 'item' ? 1.6 : 1) / (toMe + 1);
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    for (const id of Object.keys(bot.entities || {})) {
      const e = bot.entities[id];
      if (!e || e.name !== 'item' || !e.position) continue;
      const toMe = me.distanceTo(e.position);
      const toDest = e.position.distanceTo(destV);
      if (toMe < 1.5 || toMe > 16 || toDest >= remain) continue;
      const score = 1.4 / (toMe + 1);
      if (score > bestScore) {
        best = { kind: 'item', x: e.position.x, y: e.position.y, z: e.position.z };
        bestScore = score;
      }
    }
    return best;
  }

  consumeNear(bot, radius = 1.8) {
    if (!bot?.entity) return;
    const me = bot.entity.position;
    this.traces = this.traces.filter((t) => me.distanceTo(new Vec3(t.x, t.y, t.z)) > radius);
  }
}

function hashAngle(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return (h % 360) / 360 * Math.PI * 2;
}

function circleSlot(bot, center, radius = 3.1) {
  const c = new Vec3(center.x, center.y, center.z);
  let crowd = 1;
  for (const name of Object.keys(bot.players || {})) {
    if (name === bot.username) continue;
    const e = bot.players[name]?.entity;
    if (e?.position && e.position.distanceTo(c) < 8) crowd += 1;
  }
  const n = Math.max(crowd, 3);
  const ang = hashAngle(bot.username) + (2 * Math.PI) / n;
  return {
    x: c.x + Math.cos(ang) * radius,
    y: c.y,
    z: c.z + Math.sin(ang) * radius,
  };
}

function tooCloseToAnyone(bot, min = 1.65) {
  const me = bot.entity?.position;
  if (!me) return false;
  for (const name of Object.keys(bot.players || {})) {
    if (name === bot.username) continue;
    const e = bot.players[name]?.entity;
    if (e?.position && me.distanceTo(e.position) < min) return true;
  }
  return false;
}

async function glanceAround(bot) {
  try {
    const others = [];
    for (const name of Object.keys(bot.players || {})) {
      const e = bot.players[name]?.entity;
      if (e?.position && e !== bot.entity) others.push(e);
    }
    if (others.length && Math.random() < 0.55) {
      const e = others[Math.floor(Math.random() * others.length)];
      await bot.lookAt(e.position.offset(0, e.height * 0.8, 0), true);
      return;
    }
    const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.4;
    const pitch = Math.max(-0.6, Math.min(0.4, bot.entity.pitch + (Math.random() - 0.5) * 0.35));
    await bot.look(yaw, pitch, true);
  } catch {
    /* */
  }
}

async function lookAtPos(bot, pos, dy = 0.5) {
  if (!pos) return;
  try {
    await bot.lookAt(new Vec3(pos.x, pos.y + dy, pos.z), true);
  } catch {
    /* */
  }
}

async function emote(bot, kind, opts = {}) {
  const k = String(kind || '').toLowerCase();
  if (k === 'jump' || k === 'wave' || k === 'hi') {
    try {
      if (opts.target) await lookAtPos(bot, opts.target, opts.target.height ? opts.target.height * 0.85 : 1);
      bot.setControlState('jump', true);
      await sleep(180 + Math.random() * 120);
      bot.setControlState('jump', false);
    } catch {
      /* */
    }
    return 'jump';
  }
  if (k === 'sneak' || k === 'careful') {
    try {
      bot.setControlState('sneak', true);
      await sleep(500 + Math.random() * 400);
    } catch {
      /* */
    } finally {
      try {
        bot.setControlState('sneak', false);
      } catch {
        /* */
      }
    }
    return 'sneak';
  }
  if (k === 'point' || k === '这个') {
    const block = opts.block || bot.blockAtCursor?.(5) || bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (block?.position) await lookAtPos(bot, block.position, 0.4);
    await sleep(200);
    try {
      bot.chat(opts.text || '这个');
    } catch {
      /* */
    }
    return 'point';
  }
  await glanceAround(bot);
  return 'glance';
}

async function waitPose(bot) {
  const sit = bot.findBlock({
    matching: (b) =>
      b &&
      (b.name.includes('stairs') ||
        b.name.includes('slab') ||
        b.name.endsWith('_log') ||
        b.name.includes('wall')),
    maxDistance: 5,
  });
  if (sit) {
    await lookAtPos(bot, sit.position, 0.3);
    try {
      bot.setControlState('sneak', true);
    } catch {
      /* */
    }
    await sleep(400 + Math.random() * 500);
    try {
      bot.setControlState('sneak', false);
    } catch {
      /* */
    }
    return { pose: 'lean', block: sit.name };
  }
  try {
    bot.setControlState('sneak', true);
  } catch {
    /* */
  }
  await glanceAround(bot);
  await sleep(300 + Math.random() * 400);
  try {
    bot.setControlState('sneak', false);
  } catch {
    /* */
  }
  return { pose: 'wait' };
}

function lavaNear(bot) {
  if (!bot?.entity) return null;
  const p = bot.entity.position;
  for (const off of [
    [0, 0, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
  ]) {
    const b = bot.blockAt(p.offset(off[0], off[1], off[2]));
    if (b && (b.name === 'lava' || b.name === 'fire' || b.name.includes('lava'))) return b.position;
  }
  return null;
}

function pickReactLine(kind, soul) {
  const style = soul?.speech_style || '';
  const wild = /chaos|impulsive|chaotic/i.test(style);
  const terse = /terse|practical/i.test(style);
  const table = {
    named: wild ? ['啊？', '叫我干嘛'] : terse ? ['嗯。', '咋了'] : ['嗯？', '叫我？', '在'],
    explode: wild ? ['卧槽啥响', '跑？'] : terse ? ['爆炸'] : ['啥声音', '炸了？'],
    ore: wild ? ['亮的！'] : terse ? ['矿'] : ['这是…', '矿？'],
    lava: ['烫', '岩浆！'],
    death: wild ? ['有人没了', '笑死'] : terse ? ['死了'] : ['谁没了？', '小心点'],
  };
  const lines = table[kind] || ['…'];
  return lines[Math.floor(Math.random() * lines.length)];
}

function pickMissLine(player) {
  const who = player || '你';
  const lines = [
    '到了，人呢？',
    `我到了，${who} 你还在吗`,
    `${who}？我在这`,
    '我到了啊',
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function aborted(signal) {
  return Boolean(signal?.aborted);
}

async function reactWorld(bot, soul, ev, signal) {
  if (aborted(signal)) return;
  if (ev.pos) await lookAtPos(bot, ev.pos, ev.kind === 'named' ? 1.4 : 0.5);
  else if (ev.from && bot.players[ev.from]?.entity) {
    const e = bot.players[ev.from].entity;
    await lookAtPos(bot, e.position, e.height * 0.85);
  } else {
    await glanceAround(bot);
  }
  if (aborted(signal)) return;
  const line = pickReactLine(ev.kind, soul);
  try {
    bot.chat(line);
  } catch {
    /* */
  }
  await sleep(350 + Math.random() * 500);
}

function interestingOre(name) {
  return /diamond_ore|ancient_debris|emerald_ore/.test(String(name || ''));
}

function parseDeathLine(line) {
  const s = String(line || '');
  const m = s.match(
    /^<?([A-Za-z0-9_]{1,16})>? (died|was slain|fell|drowned|burned|tried to swim|hit the ground|went up in flames|was blown up|starved|suffocated)/i
  );
  if (!m) return null;
  return { name: m[1], how: m[2] };
}

function findShelterLight(bot, range = 24) {
  return bot.findBlock({
    matching: (b) =>
      b &&
      (b.name.includes('torch') ||
        b.name === 'lantern' ||
        b.name === 'campfire' ||
        b.name === 'soul_campfire' ||
        b.name === 'glowstone' ||
        b.name === 'jack_o_lantern' ||
        b.name === 'shroomlight'),
    maxDistance: range,
  });
}

module.exports = {
  gaitOf,
  applyGait,
  WorldSense,
  circleSlot,
  tooCloseToAnyone,
  glanceAround,
  lookAtPos,
  emote,
  waitPose,
  lavaNear,
  pickMissLine,
  pickReactLine,
  reactWorld,
  interestingOre,
  parseDeathLine,
  findShelterLight,
  blockLightLevel,
};

function blockLightLevel(block) {
  if (!block) return 15;
  const bl = Number(block.light ?? 0) || 0;
  const sl = Number(block.skyLight ?? 0) || 0;
  return Math.max(bl, sl);
}
