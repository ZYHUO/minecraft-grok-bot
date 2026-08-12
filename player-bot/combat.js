'use strict';

/**
 * Melee hunt / defend — Mindcraft attackEntity + defendSelf, without mineflayer-pvp.
 * One body, one target at a time. No raid director.
 */

const { goals, Movements } = require('mineflayer-pathfinder');
const { stopAll, navigateTo } = require('./actions');
const mc = require('./mcdata');

const { GoalFollow, GoalInvert } = goals;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.code = 'ABORTED';
    throw err;
  }
}

function metaAt(entity, idx) {
  const md = entity?.metadata;
  if (!md) return undefined;
  return md[idx];
}

function isBaby(entity) {
  for (const i of [16, 15, 9]) {
    const v = metaAt(entity, i);
    if (v === true) return true;
    if (v && typeof v === 'object' && v.value === true) return true;
  }
  const n = (entity?.name || '').toLowerCase();
  if (entity?.height && entity.height < 0.65 && mc.isHuntableName(n)) return true;
  return false;
}

function hasNametag(entity) {
  if (!entity) return false;
  const label = entity.username || entity.displayName;
  if (typeof label === 'string' && label && label !== entity.name) return true;
  const tag = metaAt(entity, 2);
  if (typeof tag === 'string' && tag.trim()) return true;
  if (tag && typeof tag === 'object' && String(tag.value || '').trim()) return true;
  return false;
}

function desiredGap(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'creeper' || n === 'phantom') {
    return { min: 4, max: 5.8, follow: 4.6, back: 5.4 };
  }
  return { min: 1.6, max: 3.3, follow: 2.4, back: 2.3 };
}

function weaponScore(item) {
  if (!item?.name) return -1;
  const name = item.name;
  if (name.includes('pickaxe')) {
    /* fall through as tool */
  } else if (name.includes('sword')) {
    return (item.attackDamage || 6) + 0.5;
  } else if (name.includes('axe')) {
    return (item.attackDamage || 7) + 0.15;
  }
  if (typeof item.attackDamage === 'number' && item.attackDamage > 1) {
    return item.attackDamage;
  }
  const mats = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wood', 'wooden'];
  let mat = 0;
  for (let i = 0; i < mats.length; i++) {
    if (name.includes(mats[i])) mat = mats.length - i;
  }
  if (name.includes('sword')) return 10 + mat;
  if (name.includes('axe') && !name.includes('pickaxe')) return 8 + mat;
  if (name.includes('pickaxe') || name.includes('shovel') || name.includes('hoe')) return 3 + mat;
  return 0;
}

function bestWeapon(bot) {
  const items = bot.inventory?.items() || [];
  let best = null;
  let score = 0;
  for (const it of items) {
    const s = weaponScore(it);
    if (s > score) {
      score = s;
      best = it;
    }
  }
  return best;
}

async function equipBestWeapon(bot) {
  const w = bestWeapon(bot);
  if (!w) return null;
  if (bot.heldItem && bot.heldItem.name === w.name) return w;
  try {
    await bot.equip(w, 'hand');
  } catch {
    /* */
  }
  return w;
}

async function maybeEquipShield(bot) {
  const off = bot.inventory?.slots?.[45];
  if (off?.name === 'shield') return true;
  const shield = (bot.inventory?.items() || []).find((i) => i.name === 'shield');
  if (!shield) return false;
  try {
    await bot.equip(shield, 'off-hand');
    return true;
  } catch {
    return false;
  }
}

async function nibbleFood(bot) {
  const foods = bot.registry?.foodsByName || {};
  const item = (bot.inventory?.items() || [])
    .filter((i) => foods[i.name])
    .sort((a, b) => (foods[b.name]?.foodPoints || 0) - (foods[a.name]?.foodPoints || 0))[0];
  if (!item || typeof bot.consume !== 'function') return false;
  try {
    await bot.equip(item, 'hand');
    await bot.consume();
    return true;
  } catch {
    return false;
  }
}

function liveEntity(bot, entity) {
  if (!entity) return null;
  const cur = bot.entities[entity.id];
  if (!cur?.position || cur === bot.entity) return null;
  if (cur.isValid === false) return null;
  return cur;
}

function findTarget(bot, opts = {}) {
  const range = Number(opts.range || 24);
  const skipBaby = opts.skipBaby !== false;
  const skipNamed = opts.skipNamed !== false;
  const me = bot.entity?.position;
  if (!me) return null;

  if (opts.entity_id !== undefined && opts.entity_id !== null && opts.entity_id !== '') {
    const e = bot.entities[Number(opts.entity_id)];
    if (e?.position && e !== bot.entity) return e;
  }

  if (opts.player) {
    const p = bot.players?.[opts.player]?.entity;
    if (p?.position) return p;
  }

  const want = String(opts.name || opts.mob || opts.entity || '').toLowerCase();
  const prefer = opts.prefer || (want ? 'named' : 'any');

  let best = null;
  let bestD = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || e === bot.entity) continue;
    if (e.type === 'player' && prefer !== 'player' && !want) continue;
    const n = (e.name || e.username || '').toLowerCase();
    if (n === 'item' || n === 'experience_orb' || n === 'arrow') continue;
    if (skipBaby && isBaby(e)) continue;
    if (skipNamed && hasNametag(e) && prefer !== 'named') continue;
    if (want && n !== want && !n.includes(want) && (e.username || '').toLowerCase() !== want) continue;
    if (!want) {
      if (prefer === 'hostile' && !mc.isHostileName(n)) continue;
      if (prefer === 'huntable' && !mc.isHuntableName(n)) continue;
      if (prefer === 'any' && !mc.isHostileName(n) && !mc.isHuntableName(n)) continue;
    }
    const d = me.distanceTo(e.position);
    if (d < bestD && d <= range) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function setCombatMoves(bot) {
  const mv = new Movements(bot);
  mv.canDig = false;
  mv.allow1by1towers = false;
  bot.pathfinder.setMovements(mv);
}

function setStance(bot, entity, kind, gap, state) {
  if (state.stance === kind && state.targetId === entity.id) return;
  state.stance = kind;
  state.targetId = entity.id;
  try {
    setCombatMoves(bot);
    if (kind === 'close') {
      bot.pathfinder.setGoal(new GoalFollow(entity, gap.follow), true);
    } else if (kind === 'back') {
      bot.pathfinder.setGoal(new GoalInvert(new GoalFollow(entity, gap.back)), true);
    } else {
      bot.pathfinder.setGoal(null);
    }
  } catch {
    /* */
  }
}

async function lookCombat(bot, entity) {
  const n = (entity.name || '').toLowerCase();
  const offY = n === 'enderman' ? 0.15 : (entity.height || 1.8) * 0.72;
  try {
    await bot.lookAt(entity.position.offset(0, offY, 0), true);
  } catch {
    /* */
  }
}

function tapStrafe(bot) {
  if (Math.random() > 0.4) return;
  const dir = Math.random() < 0.5 ? 'left' : 'right';
  try {
    bot.setControlState(dir, true);
    setTimeout(() => {
      try {
        bot.setControlState(dir, false);
      } catch {
        /* */
      }
    }, 160 + Math.random() * 220);
  } catch {
    /* */
  }
}

async function clearMotors(bot) {
  try {
    bot.pathfinder.setGoal(null);
  } catch {
    /* */
  }
  try {
    await stopAll(bot);
  } catch {
    /* */
  }
  for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) {
    try {
      bot.setControlState(k, false);
    } catch {
      /* */
    }
  }
}

async function pickupDrops(bot, config, signal, range = 8) {
  const me = bot.entity?.position;
  if (!me) return 0;
  const items = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e?.name !== 'item' || !e.position) continue;
    const d = me.distanceTo(e.position);
    if (d <= range) items.push({ e, d });
  }
  items.sort((a, b) => a.d - b.d);
  let n = 0;
  for (const { e } of items.slice(0, 6)) {
    throwIfAborted(signal);
    if (!liveEntity(bot, e) && !bot.entities[e.id]) continue;
    try {
      await navigateTo(bot, config, e.position, 1, 6000, signal);
      n += 1;
      await sleep(220);
    } catch (err) {
      if (err.code === 'ABORTED') throw err;
      break;
    }
  }
  return n;
}

/**
 * Fight one entity until it is gone, we abort, or we time out.
 */
async function huntEntity(bot, config, entity, opts = {}) {
  const signal = opts.signal;
  const shouldStop = opts.shouldStop || (() => false);
  const timeoutMs = Number(opts.timeoutMs || 45000);
  const reach = Number(config.attackDistance || 3.5);
  const deadline = Date.now() + timeoutMs;
  const state = { stance: null, targetId: null };
  let swings = 0;
  let lastEat = 0;
  let lastSwing = 0;

  await equipBestWeapon(bot);
  if (mc.isHostileName(entity.name)) await maybeEquipShield(bot);

  try {
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (shouldStop()) {
        const err = new Error('aborted');
        err.code = 'ABORTED';
        throw err;
      }
      const cur = liveEntity(bot, entity);
      if (!cur) {
        return { ok: true, killed: true, swings, name: entity.name, id: entity.id };
      }

      if (bot.health !== undefined && bot.health <= 5 && Date.now() - lastEat > 5000) {
        lastEat = Date.now();
        await nibbleFood(bot);
        await equipBestWeapon(bot);
      }

      const d = bot.entity.position.distanceTo(cur.position);
      const gap = desiredGap(cur.name);

      if (d > gap.max) setStance(bot, cur, 'close', gap, state);
      else if (d < gap.min) setStance(bot, cur, 'back', gap, state);
      else setStance(bot, cur, 'hold', gap, state);

      const inReach = d <= Math.max(reach, gap.max + 0.4);
      const now = Date.now();
      if (inReach && now - lastSwing >= 520) {
        await lookCombat(bot, cur);
        tapStrafe(bot);
        try {
          await bot.attack(cur);
          swings += 1;
          lastSwing = now;
        } catch {
          /* entity may have died mid-swing */
        }
      }
      await sleep(inReach ? 180 : 140);
    }
    return { ok: true, killed: false, lost: true, swings, name: entity.name, id: entity.id };
  } finally {
    await clearMotors(bot);
  }
}

async function hunt(bot, config, opts = {}) {
  const count = Math.max(1, Number(opts.count || 1));
  const range = Number(opts.range || 24);
  const prefer = opts.prefer || (opts.name || opts.player || opts.entity_id ? 'named' : 'huntable');
  const results = [];
  let picked = 0;

  for (let i = 0; i < count; i++) {
    throwIfAborted(opts.signal);
    if (opts.shouldStop?.()) break;
    let target = findTarget(bot, { ...opts, range, prefer: prefer === 'huntable' && i === 0 ? 'huntable' : prefer });
    if (!target && prefer === 'huntable' && !opts.name) {
      target = findTarget(bot, { ...opts, range, prefer: 'hostile' });
    }
    if (!target) {
      if (i === 0) {
        const err = new Error('No hunt target nearby');
        err.code = 'NOT_FOUND';
        throw err;
      }
      break;
    }
    const one = await huntEntity(bot, config, target, opts);
    results.push(one);
    if (one.killed) {
      try {
        picked += await pickupDrops(bot, config, opts.signal, 8);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
      }
    }
  }

  const killed = results.filter((r) => r.killed).length;
  return {
    ok: true,
    message: killed ? 'hunt_done' : 'hunt_lost',
    killed,
    wanted: count,
    picked,
    targets: results.map((r) => ({ name: r.name, id: r.id, killed: r.killed, swings: r.swings })),
  };
}

async function defendArea(bot, config, opts = {}) {
  const range = Number(opts.range || 8);
  const deadline = Date.now() + Number(opts.timeoutMs || 90000);
  const fought = [];
  let picked = 0;

  while (Date.now() < deadline) {
    throwIfAborted(opts.signal);
    if (opts.shouldStop?.()) break;
    const flee = findTarget(bot, { range: range + 4, prefer: 'hostile', skipBaby: false, skipNamed: false });
    if (flee && mc.isFleeAlwaysName(flee.name)) {
      return { ok: true, message: 'flee', name: flee.name, fought, picked };
    }
    const enemy = findTarget(bot, { range, prefer: 'hostile', skipBaby: false, skipNamed: false });
    if (!enemy) break;
    const one = await huntEntity(bot, config, enemy, {
      ...opts,
      timeoutMs: Math.min(40000, deadline - Date.now()),
    });
    fought.push(one);
    if (one.killed) {
      try {
        picked += await pickupDrops(bot, config, opts.signal, 7);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
      }
    }
    if (!one.killed && !liveEntity(bot, enemy)) continue;
    if (!one.killed) break;
  }

  return {
    ok: true,
    message: fought.length ? 'defended' : 'clear',
    killed: fought.filter((r) => r.killed).length,
    picked,
    targets: fought.map((r) => ({ name: r.name, id: r.id, killed: r.killed, swings: r.swings })),
  };
}

module.exports = {
  isBaby,
  hasNametag,
  desiredGap,
  weaponScore,
  bestWeapon,
  findTarget,
  huntEntity,
  hunt,
  defendArea,
  pickupDrops,
  equipBestWeapon,
};
