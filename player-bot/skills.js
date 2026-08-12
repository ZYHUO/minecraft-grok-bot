'use strict';

/**
 * High-level skills — Mindcraft-inspired, local to one body.
 * No multi-bot orchestration. Async world notes = signs / books / places.
 */

const { Vec3 } = require('vec3');
const { goals: { GoalNear } } = require('mineflayer-pathfinder');
const { navigateTo, findItemByName, stopAll } = require('./actions');
const mc = require('./mcdata');
const combat = require('./combat');
const coord = require('./coord');
const presence = require('./presence');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ok(message, extra = {}) {
  return { ok: true, message, ...extra };
}

function fail(message, code = 'ERROR', extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  throw err;
}

function countItem(bot, name) {
  if (!bot?.inventory) return 0;
  const lower = String(name).toLowerCase();
  const items = bot.inventory.items();
  const exact = items.filter((i) => i.name === lower);
  if (exact.length) return exact.reduce((a, b) => a + b.count, 0);
  return items
    .filter((i) => i.name.includes(lower))
    .reduce((a, b) => a + b.count, 0);
}

function invSummary(bot) {
  const counts = {};
  if (!bot?.inventory) return counts;
  for (const it of bot.inventory.items()) {
    counts[it.name] = (counts[it.name] || 0) + it.count;
  }
  return counts;
}

function nearestBlock(bot, names, maxDistance = 32) {
  const set = new Set(
    (Array.isArray(names) ? names : [names]).map((n) => String(n).toLowerCase())
  );
  return bot.findBlock({
    matching: (b) => b && set.has(b.name),
    maxDistance,
  });
}

function nearestEntity(bot, name, maxDistance = 24) {
  const want = String(name || '').toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || e === bot.entity) continue;
    const n = (e.name || e.username || e.displayName || e.type || '').toLowerCase();
    if (want && n !== want && !n.includes(want)) continue;
    if (!want && e.type === 'player') continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d < bestD && d <= maxDistance) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function isAir(name) {
  return !name || name === 'air' || name === 'cave_air' || name === 'void_air';
}

function splitSignLines(text) {
  const raw = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.slice(0, 45));
  while (raw.length < 4) raw.push('');
  return raw.slice(0, 4).join('\n');
}

function ensureConnected(bot) {
  if (!bot?.entity) fail('Bot not connected', 'NOT_CONNECTED');
}

function throwIfAborted(ctx) {
  if (ctx?.signal?.aborted) fail('aborted', 'ABORTED');
}

async function nav(ctx, pos, range, timeoutMs) {
  throwIfAborted(ctx);
  const t = timeoutMs || ctx.config?.moveTimeoutMs || 20000;
  await navigateTo(ctx.bot, ctx.config, pos, range, t, ctx.signal || null);
}

function chatComponentText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(chatComponentText).join('');
  if (typeof node === 'object') {
    return String(node.text || '') + chatComponentText(node.extra);
  }
  return String(node);
}

function bookPageToText(p) {
  if (p == null) return '';
  if (typeof p === 'object' && p.value !== undefined && typeof p.value !== 'object') {
    return bookPageToText(p.value);
  }
  if (typeof p === 'object' && p.value && typeof p.value === 'object') {
    return bookPageToText(p.value);
  }
  if (typeof p !== 'string') return chatComponentText(p).replace(/§./g, '');
  const stripped = p.replace(/§./g, '');
  const t = stripped.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return chatComponentText(JSON.parse(t)).replace(/§./g, '');
    } catch {
      return stripped;
    }
  }
  return stripped;
}

function signTextOf(sign) {
  if (!sign) return { text: '', available: false };
  let text = sign.signText;
  if (Array.isArray(text)) text = text.join('\n');
  if (text && typeof text === 'object') text = chatComponentText(text);
  if (typeof text === 'string' && text.trim()) {
    return { text, available: true };
  }
  if (sign.entity) {
    try {
      const e = sign.entity;
      const lines = [e.Text1, e.Text2, e.Text3, e.Text4]
        .filter((v) => v != null)
        .map((t) => bookPageToText(typeof t === 'string' ? t : t));
      if (e.front_text) lines.push(bookPageToText(e.front_text));
      if (e.back_text) lines.push(bookPageToText(e.back_text));
      const joined = lines.filter(Boolean).join('\n');
      if (joined) return { text: joined, available: true };
    } catch {
      /* */
    }
  }
  const hasField = sign.signText != null || sign.entity != null;
  return { text: typeof text === 'string' ? text : '', available: hasField };
}

// ---------- skills ----------

async function gather(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const want = String(args.block || args.name || 'oak_log').toLowerCase();
  const types = mc.expandBlockAlias(want);
  const count = Number(args.count || 8);
  const max_distance = Number(args.max_distance || 32);
  const startBy = {};
  for (const t of types) startBy[t] = countItem(bot, t);
  const gatheredNow = () =>
    types.reduce((a, t) => a + countItem(bot, t), 0) - types.reduce((a, t) => a + (startBy[t] || 0), 0);
  const manual = types.some((t) => mc.mustCollectManually(t));

  for (let i = 0; i < count * 3 && gatheredNow() < count; i++) {
    throwIfAborted(ctx);
    if (mc.emptySlotCount(bot) <= 1) {
      return ok('gather_partial', {
        gathered: gatheredNow(),
        item: want,
        types,
        error: 'INVENTORY_FULL',
      });
    }
    const block = bot.findBlock({
      matching: (b) => b && types.includes(b.name),
      maxDistance: max_distance,
    });
    if (!block) break;
    try {
      if (bot.tool?.equipForBlock) await bot.tool.equipForBlock(block);
      const heldId = bot.heldItem ? bot.heldItem.type : null;
      if (typeof block.canHarvest === 'function' && !block.canHarvest(heldId)) {
        fail(`Need better tool for ${block.name}`, 'NEED_TOOL', { block: block.name });
      }
      if (manual || typeof bot.collectBlock?.collect !== 'function') {
        await runAction({
          type: 'dig',
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
        });
        await sleep(400);
      } else {
        await bot.collectBlock.collect(block);
      }
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
      if (e.name === 'NoChests' || /inventory full/i.test(e.message || '')) {
        return ok('gather_partial', { gathered: gatheredNow(), item: want, types, error: 'INVENTORY_FULL' });
      }
      return ok('gather_partial', { gathered: gatheredNow(), item: want, types, error: e.message });
    }
  }
  const got = gatheredNow();
  return ok(got >= count ? 'gather_done' : 'gather_partial', {
    gathered: got,
    item: want,
    types,
    inventory: countItem(bot, want),
  });
}

async function pickup(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const range = Number(args.range || 16);
  // walk over item entities
  const items = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e.name !== 'item') continue;
    if (!e.position) continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d <= range) items.push({ e, d });
  }
  items.sort((a, b) => a.d - b.d);
  let n = 0;
  for (const { e } of items.slice(0, Number(args.limit || 12))) {
    throwIfAborted(ctx);
    try {
      await nav(ctx, e.position, 1, 15000);
      n += 1;
      await sleep(300);
    } catch (err) {
      if (err.code === 'ABORTED') throw err;
    }
  }
  return ok('pickup_done', { approached: n });
}

function nearestFreeSpace(bot, range = 6) {
  const origin = bot.entity.position.floored();
  for (let r = 1; r <= range; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = origin.offset(dx, 0, dz);
        const feet = bot.blockAt(p);
        const below = bot.blockAt(p.offset(0, -1, 0));
        if (feet && isAir(feet.name) && below && !isAir(below.name) && !isFluidName(below.name)) {
          return p;
        }
      }
    }
  }
  return null;
}

async function ensureCraftingTable(ctx) {
  const { bot, runAction } = ctx;
  let table = nearestBlock(bot, 'crafting_table', 16);
  if (table) {
    if (bot.entity.position.distanceTo(table.position) > 3) {
      await nav(ctx, table.position, 2, 20000);
    }
    return { table, placed: false };
  }
  const item = findItemByName(bot, 'crafting_table');
  if (!item) return { table: null, placed: false };
  const spot = nearestFreeSpace(bot, 6);
  if (!spot) return { table: null, placed: false };
  await runAction({ type: 'place', item: 'crafting_table', x: spot.x, y: spot.y, z: spot.z });
  await sleep(300);
  table = bot.blockAt(spot);
  return { table: table && table.name === 'crafting_table' ? table : nearestBlock(bot, 'crafting_table', 6), placed: true };
}

async function craftPlanksFromLogs(ctx) {
  const { bot, runAction } = ctx;
  const wood = (bot.inventory?.items() || []).filter((i) => mc.isLogName(i.name));
  if (!wood.length) return false;
  const plankNames = Object.keys(bot.registry?.itemsByName || {}).filter((n) => mc.isPlankName(n));
  for (const name of plankNames) {
    const id = bot.registry.itemsByName[name].id;
    const recs = bot.recipesFor(id, null, 1, null) || [];
    if (!recs.length) continue;
    await runAction({ type: 'craft', item: name, count: 4 });
    return true;
  }
  return false;
}

async function craft(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const raw = args.item || args.name;
  const count = Number(args.count || 1);
  if (!raw) fail('craft requires item', 'BAD_ARGS');
  const item = mc.resolveItemName(bot, raw);
  const id = bot.registry?.itemsByName?.[item]?.id;
  if (id == null) fail(`Unknown item: ${raw}`, 'BAD_ARGS');

  let twoByTwo = bot.recipesFor(id, null, 1, null) || [];
  if (!twoByTwo.length && item === 'crafting_table') {
    await craftPlanksFromLogs(ctx);
    twoByTwo = bot.recipesFor(id, null, 1, null) || [];
  }

  let tablePos = null;
  if (!twoByTwo.length) {
    const { table } = await ensureCraftingTable(ctx);
    if (table) {
      tablePos = table.position;
    } else {
      const withTable = bot.recipesAll?.(id, null, true) || [];
      if (withTable.some((r) => r.requiresTable)) {
        fail('Need a crafting_table nearby or in inventory', 'NOT_FOUND');
      }
    }
  }

  const body = { type: 'craft', item, count };
  if (tablePos) {
    body.table_x = tablePos.x;
    body.table_y = tablePos.y;
    body.table_z = tablePos.z;
  }
  return runAction(body);
}

async function goTo(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const x = Number(args.x);
  const y = Number(args.y);
  const z = Number(args.z);
  if (![x, y, z].every((n) => Number.isFinite(n))) {
    fail('goto requires numeric x,y,z', 'BAD_ARGS');
  }
  return runAction({
    type: 'move_to',
    x,
    y,
    z,
    range: args.range ?? 2,
  });
}

function jitterPos(pos, radius = 3) {
  const a = Math.random() * Math.PI * 2;
  const r = 1.2 + Math.random() * radius;
  return {
    x: pos.x + Math.cos(a) * r,
    y: pos.y,
    z: pos.z + Math.sin(a) * r,
  };
}

async function arriveSoft(bot, entity, soul, ctx) {
  try {
    bot.pathfinder?.setGoal?.(null);
  } catch {
    /* */
  }
  try {
    bot.setControlState('sprint', false);
    bot.setControlState('forward', false);
  } catch {
    /* */
  }
  await sleep(180 + Math.random() * 280);
  throwIfAborted(ctx);
  if (entity?.position && presence.tooCloseToAnyone(bot, 1.7)) {
    const slot = presence.circleSlot(bot, entity.position, 3.1);
    try {
      bot.pathfinder.setGoal(new GoalNear(slot.x, slot.y, slot.z, 1));
      await sleep(700 + Math.random() * 400);
      throwIfAborted(ctx);
      bot.pathfinder.setGoal(null);
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
    }
  }
  try {
    bot.clearControlStates();
  } catch {
    /* */
  }
  throwIfAborted(ctx);
  if (entity?.position) {
    try {
      await bot.lookAt(entity.position.offset(0, entity.height * 0.85, 0), true);
    } catch {
      /* */
    }
    throwIfAborted(ctx);
    if (presence.gaitOf(soul).greet_jump) {
      await presence.emote(bot, 'jump', { target: entity.position });
    }
    await sleep(280 + Math.random() * 500);
    throwIfAborted(ctx);
  }
}

function resolvePeerName(bot, peers, name) {
  if (!name) return null;
  const want = String(name).toLowerCase();
  if (bot.players[name] && !presence.isSpectator(bot, name)) return name;
  const hit = Object.keys(bot.players || {}).find(
    (n) => n.toLowerCase() === want && !presence.isSpectator(bot, n)
  );
  if (hit) return hit;
  const p = peers?.get?.(name);
  if (p && presence.isSpectator(bot, p.name)) return null;
  return p?.name || name;
}

async function goToPlayer(ctx, args) {
  return goFind(ctx, { ...args, range: args.range || 4 });
}

async function goFind(ctx, args) {
  const { bot, config, peers, soul, sense } = ctx;
  ensureConnected(bot);
  if (peers?.observeVisible) peers.observeVisible(bot);
  const rawName = args.player || args.name;
  if (rawName && presence.isSpectator(bot, rawName)) {
    fail(`${rawName} is spectating — ignored`, 'NOT_FOUND');
  }
  const player = resolvePeerName(bot, peers, rawName);
  const heard = player ? peers?.get?.(player) : null;
  let dest = null;
  let how = 'coords';

  if (args.x !== undefined && args.z !== undefined) {
    dest = {
      x: Number(args.x),
      y: args.y !== undefined ? Number(args.y) : bot.entity.position.y,
      z: Number(args.z),
    };
    how = 'given';
  } else if (player && presence.playerEntity(bot, player)) {
    dest = presence.playerEntity(bot, player).position;
    how = 'sight';
  } else if (heard) {
    dest = { x: heard.x, y: heard.y ?? bot.entity.position.y, z: heard.z };
    how = heard.source || 'heard';
  } else if (!player) {
    const last = (peers?.list?.() || []).sort((a, b) => a.age_s - b.age_s)[0];
    if (last) {
      dest = { x: last.x, y: last.y ?? bot.entity.position.y, z: last.z };
      how = 'last_peer';
    }
  }
  if (!dest) {
    fail(
      player
        ? `Don't know where ${player} is. Wait for them to shout coords, or skill shout_meet yourself.`
        : 'go_find needs a player name, or someone must have shouted coords',
      'NOT_FOUND',
      { peers: peers?.list?.() || [] }
    );
  }

  const loose = Number(args.range || 5);
  const timeout = Number(args.timeout_ms || config?.moveTimeoutMs || 90000);
  const end = Date.now() + timeout;
  let lastGlance = 0;
  let lastGoalAt = 0;
  let lastJitterAt = 0;
  let target = jitterPos(dest, 3);
  let onTrace = false;
  const gait = presence.gaitOf(soul);

  const setWalkGoal = (pos, range) => {
    bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, range));
    lastGoalAt = Date.now();
  };

  while (Date.now() < end) {
    throwIfAborted(ctx);
    if (peers?.observeVisible) peers.observeVisible(bot);

    const lava = presence.lavaNear(bot);
    if (lava) sense?.push?.('lava', { pos: lava });
    const evs = sense?.take?.() || [];
    if (evs.length) {
      try {
        bot.pathfinder?.setGoal?.(null);
      } catch {
        /* */
      }
      await presence.reactWorld(bot, soul, evs[evs.length - 1], ctx.signal);
      throwIfAborted(ctx);
      lastGoalAt = 0;
    }

    const live = player ? presence.playerEntity(bot, player) : null;
    if (live?.position) {
      dest = live.position;
      how = 'sight';
      onTrace = false;
      const d = bot.entity.position.distanceTo(live.position);
      presence.applyGait(bot, soul, d);
      if (d <= loose) {
        await arriveSoft(bot, live, soul, ctx);
        throwIfAborted(ctx);
        return ok('found', {
          player,
          how,
          dist: Number(d.toFixed(1)),
          pos: { x: live.position.x, y: live.position.y, z: live.position.z },
        });
      }
      if (Date.now() - lastJitterAt > 1800) {
        target = presence.tooCloseToAnyone(bot)
          ? presence.circleSlot(bot, live.position, 3.1)
          : jitterPos(live.position, 2.4);
        lastJitterAt = Date.now();
        lastGoalAt = 0;
      }
    } else {
      const destV = new Vec3(dest.x, dest.y, dest.z);
      const dDest = bot.entity.position.distanceTo(destV);
      const trace = dDest > loose + 4 ? sense?.pickTrace?.(bot, dest) : null;
      if (trace) {
        target = { x: trace.x, y: trace.y, z: trace.z };
        how = `trace:${trace.kind}`;
        onTrace = true;
        sense.consumeNear(bot, 1.8);
      } else {
        onTrace = false;
      }
      const d = bot.entity.position.distanceTo(onTrace ? new Vec3(target.x, target.y, target.z) : destV);
      presence.applyGait(bot, soul, dDest);
      if (!onTrace && dDest <= loose + 1) {
        await arriveSoft(bot, null, soul, ctx);
        throwIfAborted(ctx);
        await presence.glanceAround(bot);
        const nowLive = player ? presence.playerEntity(bot, player) : null;
        if (nowLive) continue;
        try {
          bot.chat(presence.pickMissLine(player));
        } catch {
          /* */
        }
        throwIfAborted(ctx);
        const pose = await presence.waitPose(bot);
        throwIfAborted(ctx);
        return ok('arrived_area', {
          player: player || null,
          how,
          dist: Number(dDest.toFixed(1)),
          at: dest,
          pose,
          shouted: true,
          hint: player ? `${player} not in sight` : 'area reached',
        });
      }
    }

    if (Date.now() - lastGoalAt > 2000) {
      try {
        setWalkGoal(target, onTrace ? 1 : Math.max(2, loose - 1));
      } catch {
        await nav(ctx, target, onTrace ? 1 : loose, Math.min(15000, end - Date.now()));
      }
    }
    const glanceEvery = gait.look_interval_ms + Math.random() * 800;
    if (Date.now() - lastGlance > glanceEvery) {
      lastGlance = Date.now();
      if (Math.random() < gait.pause_chance) {
        try {
          bot.pathfinder?.setGoal?.(null);
        } catch {
          /* */
        }
        await presence.glanceAround(bot);
        throwIfAborted(ctx);
        await sleep(280 + Math.random() * 420);
        throwIfAborted(ctx);
        lastGoalAt = 0;
      }
    }
    await sleep(320 + Math.random() * 220);
  }

  try {
    bot.pathfinder?.setGoal?.(null);
  } catch {
    /* */
  }
  fail('Timed out looking for ' + (player || 'coords'), 'TIMEOUT', { how, dest });
}

async function doEmote(ctx, args) {
  const { bot, soul } = ctx;
  ensureConnected(bot);
  const kind = args.kind || args.name || args.emote || 'wave';
  const targetName = args.player || args.to;
  const ent = targetName ? presence.playerEntity(bot, targetName) : null;
  const did = await presence.emote(bot, kind, {
    target: ent?.position,
    text: args.text,
  });
  return ok('emote', { kind: did, soul: soul?.gait?.style });
}

async function listPeers(ctx) {
  ctx.peers?.observeVisible?.(ctx.bot);
  return ok('peers', { peers: ctx.peers?.list?.() || [] });
}

async function goToBlock(ctx, args) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  const blockName = args.block || args.name;
  if (!blockName) fail('go_to_block requires block', 'BAD_ARGS');
  const maxDistance = Number(args.range || args.max_distance || 64);
  const b = nearestBlock(bot, blockName, maxDistance);
  if (!b) fail(`No ${blockName} within ${maxDistance}`, 'NOT_FOUND');
  await nav(ctx, b.position, Number(args.closeness || 2), config.moveTimeoutMs);
  return ok('arrived_block', {
    block: b.name,
    pos: { x: b.position.x, y: b.position.y, z: b.position.z },
  });
}

async function moveAway(ctx, args) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  const dist = Number(args.distance || args.range || 8);
  const yaw = bot.entity.yaw + Math.PI * (0.5 + Math.random());
  const dx = -Math.sin(yaw) * dist;
  const dz = -Math.cos(yaw) * dist;
  const t = bot.entity.position.offset(dx, 0, dz);
  await nav(ctx, t, 2, 20000);
  return ok('moved_away', { to: { x: t.x, y: t.y, z: t.z } });
}

async function follow(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const player = args.player || args.name;
  if (!player) fail('follow requires player', 'BAD_ARGS');
  return runAction({
    type: 'follow_player',
    player,
    range: Number(args.range || 2),
    timeout_ms: Number(args.duration_ms || args.timeout_ms || 60000),
  });
}

async function give(ctx, args) {
  const { bot, runAction, config } = ctx;
  ensureConnected(bot);
  const player = args.player || args.to;
  const item = args.item || args.name;
  const count = Number(args.count || 1);
  if (!player || !item) fail('give requires player and item', 'BAD_ARGS');
  if (presence.isSpectator(bot, player)) fail(`${player} is spectating`, 'NOT_FOUND');
  const ent = presence.playerEntity(bot, player);
  if (!ent) fail(`Player not visible: ${player}`, 'NOT_FOUND');
  const d0 = bot.entity.position.distanceTo(ent.position);
  if (d0 < 1.5) {
    await nav(ctx, bot.entity.position.offset(2, 0, 0), 1, 8000).catch(() => {});
  }
  await nav(ctx, ent.position, 2, config.moveTimeoutMs);
  await runAction({ type: 'look_at', x: ent.position.x, y: ent.position.y + 1, z: ent.position.z });
  const received = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3500);
    const onCollect = (collector) => {
      const who = collector?.username || collector?.name;
      if (who === player) {
        clearTimeout(t);
        bot.removeListener('playerCollect', onCollect);
        resolve(who);
      }
    };
    bot.on('playerCollect', onCollect);
  });
  await runAction({ type: 'toss', item, count });
  const who = await received;
  if (!who) fail(`Tossed ${item} but ${player} did not pick it up`, 'NOT_RECEIVED', { player, item, count });
  return ok('gave', { player, item, count, received: true });
}

async function equip(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const item = args.item || args.name;
  if (!item) fail('equip requires item', 'BAD_ARGS');
  return runAction({
    type: 'equip',
    item,
    destination: args.destination || args.slot || 'hand',
  });
}

async function discard(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const item = args.item || args.name;
  if (!item) fail('discard requires item', 'BAD_ARGS');
  const count = args.count !== undefined ? Number(args.count) : 64;
  return runAction({ type: 'toss', item, count });
}

async function consume(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  let item = null;
  if (args.item || args.name) {
    item = findItemByName(bot, args.item || args.name);
  } else {
    // best food by foodPoints if registry available
    const foods = bot.registry?.foodsByName || {};
    const candidates = bot.inventory
      .items()
      .filter((i) => foods[i.name])
      .sort((a, b) => (foods[b.name]?.foodPoints || 0) - (foods[a.name]?.foodPoints || 0));
    item = candidates[0] || null;
  }
  if (!item) fail('No food to consume', 'NOT_FOUND');
  await bot.equip(item, 'hand');
  await bot.consume();
  return ok('consumed', { item: item.name, food: bot.food, health: bot.health });
}

async function attack(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  if (args.kill === true || args.kill === 'true') return hunt(ctx, args);
  if (args.player) {
    return runAction({ type: 'attack', player: args.player });
  }
  if (args.name || args.mob || args.entity) {
    return runAction({ type: 'attack', name: args.name || args.mob || args.entity });
  }
  return runAction({ type: 'attack' });
}

async function hunt(ctx, args) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  throwIfAborted(ctx);
  const prefer = args.prefer || (args.name || args.player || args.entity_id ? 'named' : 'huntable');
  return combat.hunt(bot, config, {
    name: args.name || args.mob || args.entity,
    player: args.player,
    entity_id: args.entity_id,
    count: args.count,
    range: args.range || 24,
    prefer,
    signal: ctx.signal,
  });
}

async function defend(ctx, args) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  throwIfAborted(ctx);
  return combat.defendArea(bot, config, {
    range: args.range || 10,
    signal: ctx.signal,
    timeoutMs: args.timeout_ms,
  });
}

async function goToBed(ctx) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  const bedNames = Object.keys(bot.registry.blocksByName || {}).filter((n) => n.endsWith('_bed') || n === 'bed');
  const bed =
    nearestBlock(bot, bedNames.length ? bedNames : ['red_bed', 'white_bed', 'bed'], 32) ||
    bot.findBlock({
      matching: (b) => b && (b.name.endsWith('_bed') || b.name === 'bed'),
      maxDistance: 32,
    });
  if (!bed) fail('No bed nearby', 'NOT_FOUND');
  await nav(ctx, bed.position, 2, config.moveTimeoutMs);
  try {
    await bot.sleep(bed);
    return ok('sleeping', { bed: bed.name, pos: bed.position });
  } catch (e) {
    if (e.code === 'ABORTED') throw e;
    fail(e.message || 'bed_failed', 'BED_FAILED', {
      hint: 'Try at night, clear monsters, stand near bed',
    });
  }
}

async function stay(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const seconds = Number(args.seconds || args.duration || 15);
  await stopAll(bot);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    throwIfAborted(ctx);
    await sleep(500);
    try {
      bot.clearControlStates();
    } catch {
      /* */
    }
  }
  return ok('stayed', { seconds });
}

async function placeHere(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const item = args.item || args.block || args.name;
  if (!item) fail('place_here requires item', 'BAD_ARGS');
  const p = bot.entity.position.floored();
  // place at feet offset
  const target = p.offset(
    Number(args.dx || 0),
    Number(args.dy || 0),
    Number(args.dz || 1)
  );
  return runAction({
    type: 'place',
    item,
    x: target.x,
    y: target.y,
    z: target.z,
    face: args.face,
  });
}

function isFluidName(name) {
  if (!name) return false;
  return (
    name === 'lava' ||
    name === 'water' ||
    name === 'flowing_lava' ||
    name === 'flowing_water' ||
    name.includes('lava') ||
    name.includes('water')
  );
}

async function digDown(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const depth = Math.min(20, Number(args.distance || args.depth || 3));
  const dug = [];
  for (let i = 0; i < depth; i++) {
    throwIfAborted(ctx);
    const below = bot.entity.position.offset(0, -1, 0).floored();
    const b = bot.blockAt(below);
    if (!b || isAir(b.name)) break;
    if (isFluidName(b.name)) {
      return ok('dig_down_stop', { reason: 'fluid', dug, at: b.name });
    }
    // Never dig a floor that has fluid or long drop under it
    const under1 = bot.blockAt(below.offset(0, -1, 0));
    const under2 = bot.blockAt(below.offset(0, -2, 0));
    const under3 = bot.blockAt(below.offset(0, -3, 0));
    if (isFluidName(under1?.name) || isFluidName(under2?.name)) {
      return ok('dig_down_stop', { reason: 'fluid_below', dug, at: under1?.name || under2?.name });
    }
    if (under1 && isAir(under1.name) && under2 && isAir(under2.name)) {
      return ok('dig_down_stop', { reason: 'drop', dug });
    }
    if (under1 && isAir(under1.name) && under3 && isAir(under3.name)) {
      return ok('dig_down_stop', { reason: 'drop', dug });
    }
    try {
      await runAction({ type: 'dig', x: below.x, y: below.y, z: below.z });
      dug.push(b.name);
      await sleep(200);
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
      return ok('dig_down_partial', { dug, error: e.message });
    }
  }
  return ok('dig_down_done', { dug });
}

async function goToSurface(ctx) {
  const { bot } = ctx;
  ensureConnected(bot);
  const start = bot.entity.position.clone();
  const x = Math.floor(start.x);
  const z = Math.floor(start.z);
  const dim = String(bot.game?.dimension || '');
  const maxY = dim.includes('nether') ? 127 : Number(bot.game?.height || 320);
  const minY = Number(bot.game?.minY ?? -64);
  let surfaceY = null;
  for (let y = maxY; y >= minY; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (b && !isAir(b.name) && !isFluidName(b.name)) {
      surfaceY = y + 1;
      break;
    }
  }
  if (surfaceY != null) {
    try {
      await nav(ctx, new Vec3(start.x, surfaceY, start.z), 1, ctx.config?.moveTimeoutMs || 30000);
      return ok('surface_attempt', {
        from_y: start.y,
        y: bot.entity.position.y,
        method: 'column',
      });
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
    }
  }
  for (let i = 0; i < 40; i++) {
    throwIfAborted(ctx);
    const up = bot.entity.position.offset(0, 4, 0);
    try {
      await nav(ctx, up, 1, 15000);
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
      const head = bot.blockAt(bot.entity.position.offset(0, 2, 0));
      if (head && !isAir(head.name)) {
        try {
          await bot.dig(head);
        } catch {
          break;
        }
      } else break;
    }
  }
  return ok('surface_attempt', {
    from_y: start.y,
    y: bot.entity.position.y,
    method: 'climb',
  });
}

function findShore(bot, range = 16) {
  const me = bot.entity?.position;
  if (!me) return null;
  let best = null;
  let bestD = Infinity;
  const origin = me.floored();
  for (let dx = -range; dx <= range; dx++) {
    for (let dz = -range; dz <= range; dz++) {
      const p = origin.offset(dx, 0, dz);
      const feet = bot.blockAt(p);
      const below = bot.blockAt(p.offset(0, -1, 0));
      if (!feet || !below) continue;
      if (!isAir(feet.name) || isFluidName(feet.name)) continue;
      if (isAir(below.name) || isFluidName(below.name)) continue;
      const d = Math.abs(dx) + Math.abs(dz);
      if (d > 0 && d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

function inWater(bot) {
  if (bot.entity?.isInWater) return true;
  const b = bot.blockAt(bot.entity.position);
  const a = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  return (
    (isFluidName(b?.name) && String(b.name).includes('water')) ||
    (isFluidName(a?.name) && String(a.name).includes('water'))
  );
}

async function wrapUp(ctx) {
  const { bot } = ctx;
  ensureConnected(bot);
  throwIfAborted(ctx);
  try {
    await stopAll(bot);
  } catch {
    /* */
  }
  const wet = inWater(bot);
  if (wet) {
    const shore = findShore(bot, 16);
    if (shore) {
      try {
        await nav(ctx, shore, 2, 12000);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
      }
    }
    if (inWater(bot)) {
      try {
        await goToSurface(ctx);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
      }
    }
  }
  if ((bot.health != null && bot.health <= 14) || (bot.food != null && bot.food <= 8)) {
    try {
      await consume(ctx, {});
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
    }
  }
  const here = bot.blockAt(bot.entity.position);
  const light = presence.blockLightLevel(here);
  if (light < 9) {
    const lamp = presence.findShelterLight(bot, 24);
    if (lamp?.position) {
      try {
        await nav(ctx, lamp.position, 3, 12000);
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
      }
    }
  }
  const after = bot.blockAt(bot.entity.position);
  return ok('settled', {
    in_water: inWater(bot),
    light: presence.blockLightLevel(after),
    health: bot.health,
    food: bot.food,
  });
}

// ----- chests -----
async function openNearestChest(bot, config, maxDistance = 16) {
  const chest = nearestBlock(
    bot,
    ['chest', 'trapped_chest', 'barrel', 'ender_chest'],
    maxDistance
  );
  if (!chest) fail('No chest/barrel nearby', 'NOT_FOUND');
  if (bot.entity.position.distanceTo(chest.position) > 4) {
    await navigateTo(bot, config, chest.position, 2, config.moveTimeoutMs, null);
  }
  const container = await bot.openChest(chest);
  return { chest, container };
}

async function openNearestChestCtx(ctx, maxDistance) {
  throwIfAborted(ctx);
  const { bot, config } = ctx;
  const chest = nearestBlock(
    bot,
    ['chest', 'trapped_chest', 'barrel', 'ender_chest'],
    maxDistance
  );
  if (!chest) fail('No chest/barrel nearby', 'NOT_FOUND');
  if (bot.entity.position.distanceTo(chest.position) > 4) {
    await nav(ctx, chest.position, 2, config.moveTimeoutMs);
  }
  const container = await bot.openChest(chest);
  return { chest, container };
}

async function viewChest(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const { chest, container } = await openNearestChestCtx(ctx, Number(args.range || 16));
  try {
    const items = container
      .containerItems()
      .map((i) => ({ name: i.name, count: i.count, slot: i.slot }));
    const summary = {};
    for (const it of items) summary[it.name] = (summary[it.name] || 0) + it.count;
    return ok('chest_view', {
      pos: { x: chest.position.x, y: chest.position.y, z: chest.position.z },
      block: chest.name,
      note: chest.name === 'ender_chest' ? 'ender_chest is personal, not shared' : undefined,
      summary,
      items,
    });
  } finally {
    try {
      container.close();
    } catch {
      /* */
    }
  }
}

async function putInChest(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const itemName = args.item || args.name;
  if (!itemName) fail('put_chest requires item', 'BAD_ARGS');
  const requested = args.count !== undefined ? Number(args.count) : -1;
  if (!findItemByName(bot, itemName)) fail(`No ${itemName} in inventory`, 'NOT_FOUND');
  const { chest, container } = await openNearestChestCtx(ctx, Number(args.range || 16));
  try {
    let remaining = requested < 0 ? Infinity : requested;
    let moved = 0;
    let usedName = itemName;
    while (remaining > 0) {
      throwIfAborted(ctx);
      const item = findItemByName(bot, itemName);
      if (!item) break;
      const n = Math.min(remaining === Infinity ? item.count : remaining, item.count);
      if (n <= 0) break;
      await container.deposit(item.type, null, n);
      moved += n;
      if (remaining !== Infinity) remaining -= n;
      usedName = item.name;
    }
    if (moved === 0) fail(`Could not deposit ${itemName}`, 'ERROR');
    const short = requested >= 0 && remaining > 0;
    return ok(short ? 'put_chest_partial' : 'put_chest', {
      item: usedName,
      requested: requested < 0 ? moved : requested,
      moved,
      remaining: requested < 0 ? 0 : Math.max(0, remaining),
      count: moved,
      chest: { x: chest.position.x, y: chest.position.y, z: chest.position.z },
    });
  } finally {
    try {
      container.close();
    } catch {
      /* */
    }
  }
}

async function takeFromChest(ctx, args) {
  ensureConnected(ctx.bot);
  const itemName = args.item || args.name;
  if (!itemName) fail('take_chest requires item', 'BAD_ARGS');
  const requested = args.count !== undefined ? Number(args.count) : 1;
  const { chest, container } = await openNearestChestCtx(ctx, Number(args.range || 16));
  try {
    const lower = String(itemName).toLowerCase();
    let remaining = requested;
    let moved = 0;
    let usedName = itemName;
    while (remaining > 0) {
      throwIfAborted(ctx);
      const found = container
        .containerItems()
        .find((i) => i.name === lower || i.name.includes(lower));
      if (!found) break;
      const n = Math.min(remaining, found.count);
      await container.withdraw(found.type, null, n);
      moved += n;
      remaining -= n;
      usedName = found.name;
    }
    if (moved === 0) fail(`Chest has no ${itemName}`, 'NOT_FOUND');
    return ok(remaining > 0 ? 'take_chest_partial' : 'take_chest', {
      item: usedName,
      requested,
      moved,
      remaining: Math.max(0, remaining),
      count: moved,
      chest: { x: chest.position.x, y: chest.position.y, z: chest.position.z },
    });
  } finally {
    try {
      container.close();
    } catch {
      /* */
    }
  }
}

// ----- signs (async public notes) -----
async function writeSign(ctx, args) {
  const { bot, config, runAction } = ctx;
  ensureConnected(bot);
  const text = args.text || args.message || args.body;
  if (!text) fail('write_sign requires text (use \\n for lines, max 4×45)', 'BAD_ARGS');

  // existing sign nearby to edit?
  let sign = null;
  if (args.x !== undefined) {
    sign = bot.blockAt(new Vec3(Number(args.x), Number(args.y), Number(args.z)));
  } else {
    sign = bot.findBlock({
      matching: (b) => b && (b.name.includes('_sign') || b.name === 'sign'),
      maxDistance: Number(args.range || 4),
    });
  }

  if (!sign || !(sign.name.includes('sign'))) {
    // place a new sign if we have one
    const signItem =
      findItemByName(bot, args.item || 'oak_sign') ||
      findItemByName(bot, 'sign') ||
      bot.inventory.items().find((i) => i.name.endsWith('_sign'));
    if (!signItem) fail('No sign in inventory and no sign block nearby', 'NOT_FOUND');

    const feet = bot.entity.position.floored();
    const target = feet.offset(
      Number(args.dx || 0),
      Number(args.dy || 0),
      Number(args.dz || 1)
    );
    await runAction({
      type: 'place',
      item: signItem.name,
      x: target.x,
      y: target.y,
      z: target.z,
    });
    await sleep(400);
    sign = bot.blockAt(target);
    // wall signs may end up on adjacent solid — search near target
    if (!sign || !sign.name.includes('sign')) {
      sign = bot.findBlock({
        matching: (b) => b && b.name.includes('sign'),
        maxDistance: 3,
        point: target,
      });
    }
  }

  if (!sign || !sign.name.includes('sign')) fail('Could not find sign block to write', 'NOT_FOUND');

  if (bot.entity.position.distanceTo(sign.position) > 4) {
    await nav(ctx, sign.position, 2, 15000);
  }

  const lines = splitSignLines(text);
  bot.updateSign(sign, lines);
  await sleep(200);
  return ok('sign_written', {
    pos: { x: sign.position.x, y: sign.position.y, z: sign.position.z },
    text: lines,
  });
}

async function readSign(ctx, args) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  let sign;
  if (args.x !== undefined) {
    sign = bot.blockAt(new Vec3(Number(args.x), Number(args.y), Number(args.z)));
  } else {
    sign = bot.findBlock({
      matching: (b) => b && b.name.includes('sign'),
      maxDistance: Number(args.range || 8),
    });
  }
  if (!sign || !sign.name.includes('sign')) fail('No sign nearby', 'NOT_FOUND');
  if (bot.entity.position.distanceTo(sign.position) > 5) {
    await nav(ctx, sign.position, 2, 15000);
    sign = bot.blockAt(sign.position) || sign;
  }
  const parsed = signTextOf(sign);
  if (!parsed.available && !parsed.text) {
    fail('Sign text unavailable (chunk not loaded?)', 'TEXT_UNAVAILABLE', {
      pos: { x: sign.position.x, y: sign.position.y, z: sign.position.z },
      block: sign.name,
    });
  }
  return ok('sign_read', {
    pos: { x: sign.position.x, y: sign.position.y, z: sign.position.z },
    block: sign.name,
    text: parsed.text || '',
  });
}

async function findSigns(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const range = Number(args.range || 24);
  const limit = Number(args.limit || 32);
  const origin = bot.entity.position;
  const positions = bot.findBlocks({
    matching: (b) => b && String(b.name).includes('sign'),
    maxDistance: range,
    count: limit,
  });
  const signs = [];
  for (const pos of positions) {
    const sign = bot.blockAt(pos);
    if (!sign) continue;
    const parsed = signTextOf(sign);
    signs.push({
      pos: { x: pos.x, y: pos.y, z: pos.z },
      block: sign.name,
      text: parsed.text || '',
      available: parsed.available,
      dist: Number(origin.distanceTo(pos).toFixed(1)),
    });
  }
  signs.sort((a, b) => a.dist - b.dist);
  return ok('signs', { signs });
}

// ----- books (async portable notes) -----
async function writeBook(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const pagesIn = args.pages || args.text || args.body;
  if (!pagesIn) fail('write_book requires text or pages[]', 'BAD_ARGS');
  let pages = Array.isArray(pagesIn)
    ? pagesIn.map(String)
    : String(pagesIn)
        .split(/\n\n|\f/)
        .map((p) => p.slice(0, 256));
  if (pages.length === 0) pages = [''];
  // minecraft page limit ~100; keep small
  pages = pages.slice(0, 20).map((p) => p.slice(0, 255));

  const book =
    bot.inventory.items().find((i) => i.name === 'writable_book') ||
    findItemByName(bot, 'writable_book');
  if (!book) fail('Need writable_book in inventory', 'NOT_FOUND');

  const title = args.title || 'Note';
  const author = args.author || bot.username;
  const sign = args.sign !== false && args.sign !== 'false';

  if (sign && typeof bot.signBook === 'function') {
    await bot.signBook(book.slot, pages, author, title);
    return ok('book_signed', { title, author, pages: pages.length });
  }
  if (typeof bot.writeBook === 'function') {
    await bot.writeBook(book.slot, pages);
    return ok('book_written', { pages: pages.length, signed: false });
  }
  fail('Book API not available on this mineflayer version', 'ERROR');
}

async function readBook(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const book =
    bot.inventory.items().find((i) => i.name === 'written_book' || i.name === 'writable_book') ||
    (args.item ? findItemByName(bot, args.item) : null);
  if (!book) fail('No book in inventory', 'NOT_FOUND');
  const nbt = book.nbt?.value || book.nbt || {};
  const title = nbt.title?.value || nbt.title || null;
  const author = nbt.author?.value || nbt.author || null;
  let pages = nbt.pages?.value?.value || nbt.pages?.value || nbt.pages || [];
  if (!Array.isArray(pages)) pages = [];
  pages = pages.map((p) => bookPageToText(p));
  return ok('book_read', {
    name: book.name,
    title: title && typeof title === 'object' ? title.value || String(title) : title,
    author: author && typeof author === 'object' ? author.value || String(author) : author,
    pages,
    signed: book.name === 'written_book',
  });
}

// ----- places -----
async function rememberHere(ctx, args) {
  const { bot, places } = ctx;
  ensureConnected(bot);
  const name = args.name || args.place || args.label;
  if (!name) fail('remember_here requires name', 'BAD_ARGS');
  const p = bot.entity.position;
  const entry = places.remember(name, p, args.note || '');
  return ok('remembered', { name, ...entry });
}

async function goToPlace(ctx, args) {
  const { bot, config, places } = ctx;
  ensureConnected(bot);
  const name = args.name || args.place;
  if (!name) fail('go_place requires name', 'BAD_ARGS');
  const p = places.get(name);
  if (!p) fail(`Unknown place: ${name}. Use remember_here first.`, 'NOT_FOUND');
  await nav(ctx, new Vec3(p.x, p.y, p.z), Number(args.range || 2), config.moveTimeoutMs);
  return ok('arrived_place', { name, ...p, note: 'private to this body' });
}

async function listPlaces(ctx) {
  return ok('places', { places: ctx.places.list(), note: 'private to this body' });
}

async function forgetPlace(ctx, args) {
  const name = args.name || args.place || args.label;
  if (!name) fail('forget_place requires name', 'BAD_ARGS');
  const gone = ctx.places.forget(name);
  if (!gone) fail(`Unknown place: ${name}`, 'NOT_FOUND');
  return ok('forgot_place', { name });
}

async function activate(ctx, args) {
  const { bot, config } = ctx;
  ensureConnected(bot);
  const blockName = args.block || args.name;
  let block;
  if (args.x !== undefined) {
    block = bot.blockAt(new Vec3(Number(args.x), Number(args.y), Number(args.z)));
  } else if (blockName) {
    block = nearestBlock(bot, blockName, Number(args.range || 8));
  } else {
    block = bot.blockAtCursor?.(4);
  }
  if (!block) fail('No block to activate', 'NOT_FOUND');
  if (bot.entity.position.distanceTo(block.position) > 4) {
    await nav(ctx, block.position, 2, 15000);
  }
  await bot.activateBlock(block);
  return ok('activated', { block: block.name, pos: block.position });
}

async function lookAtPlayer(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const player = args.player || args.name;
  if (!player) fail('look_player requires player', 'BAD_ARGS');
  const ent = presence.playerEntity(bot, player);
  if (!ent) fail(`Player not visible: ${player}`, 'NOT_FOUND');
  await bot.lookAt(ent.position.offset(0, ent.height * 0.9, 0), true);
  return ok('looking', { player });
}

async function inventory(ctx) {
  ensureConnected(ctx.bot);
  return ok('inventory', { summary: invSummary(ctx.bot), held: ctx.bot.heldItem?.name || null });
}

async function say(ctx, args) {
  const text = args.text || args.message || args.body;
  if (!text) fail('say requires text', 'BAD_ARGS');
  return ctx.runAction({ type: 'chat', message: text });
}

async function craftable(ctx) {
  const { bot } = ctx;
  ensureConnected(bot);
  const { items, used_table } = mc.listCraftable(bot, 80);
  return ok('craftable', { items, used_table });
}

async function craftPlan(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const item = mc.resolveItemName(bot, args.item || args.name);
  if (!item) fail('craft_plan requires item', 'BAD_ARGS');
  const plan = mc.craftingPlan(bot, item, Number(args.count || 1));
  if (!plan.ok) fail(plan.error || 'plan failed', 'BAD_ARGS');
  return ok('craft_plan', plan);
}

async function smelt(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const itemName = String(args.item || args.name || '').toLowerCase();
  const num = Number(args.count || 1);
  if (!itemName) fail('smelt requires item (raw_iron, beef, oak_log, …)', 'BAD_ARGS');
  if (!mc.isSmeltable(itemName)) fail(`Cannot smelt ${itemName} (use raw_* / logs / food)`, 'BAD_ARGS');
  if (countItem(bot, itemName) < num) fail(`Not enough ${itemName}`, 'NOT_FOUND');

  let furnace = nearestBlock(bot, ['furnace', 'blast_furnace', 'smoker'], 16);
  let placed = false;
  if (!furnace) {
    const item = findItemByName(bot, 'furnace');
    if (!item) fail('No furnace nearby and none in inventory', 'NOT_FOUND');
    const spot = nearestFreeSpace(bot, 6);
    if (!spot) fail('No space to place furnace', 'NOT_FOUND');
    await ctx.runAction({ type: 'place', item: 'furnace', x: spot.x, y: spot.y, z: spot.z });
    await sleep(300);
    furnace = bot.blockAt(spot);
    placed = true;
  }
  if (!furnace) fail('Could not open a furnace', 'NOT_FOUND');
  if (bot.entity.position.distanceTo(furnace.position) > 4) {
    await nav(ctx, furnace.position, 2, 20000);
  }

  const win = await bot.openFurnace(furnace);
  try {
    const input = win.inputItem?.() || win.inputItem;
    if (input && input.count > 0 && input.name !== itemName) {
      fail(`Furnace busy smelting ${input.name}`, 'BUSY');
    }
    if (!win.fuelItem?.() && !win.fuelItem) {
      const fuel = mc.getSmeltingFuel(bot);
      if (!fuel) fail('No fuel (coal / charcoal / wood)', 'NOT_FOUND');
      const needFuel = Math.max(1, Math.ceil(num / (mc.fuelSmeltsPerUnit(fuel.name) || 1)));
      await win.putFuel(fuel.type, null, Math.min(needFuel, fuel.count));
    }
    const type = bot.registry.itemsByName[itemName]?.id;
    await win.putInput(type, null, num);
    let total = 0;
    let last = Date.now();
    while (total < num) {
      throwIfAborted(ctx);
      await sleep(1000);
      if (win.outputItem?.()) {
        const out = await win.takeOutput();
        if (out) {
          total += out.count;
          last = Date.now();
        }
      }
      if (Date.now() - last > 12000) break;
    }
    try {
      if (win.inputItem?.()) await win.takeInput();
    } catch {
      /* */
    }
    try {
      if (win.fuelItem?.()) await win.takeFuel();
    } catch {
      /* */
    }
    return ok(total >= num ? 'smelted' : 'smelt_partial', {
      item: itemName,
      smelted: total,
      requested: num,
      placed,
    });
  } finally {
    try {
      win.close();
    } catch {
      /* */
    }
  }
}

async function clearFurnace(ctx) {
  const { bot } = ctx;
  ensureConnected(bot);
  const furnace = nearestBlock(bot, ['furnace', 'blast_furnace', 'smoker'], 16);
  if (!furnace) fail('No furnace nearby', 'NOT_FOUND');
  if (bot.entity.position.distanceTo(furnace.position) > 4) await nav(ctx, furnace.position, 2, 15000);
  const win = await bot.openFurnace(furnace);
  try {
    const taken = {};
    for (const [key, fn] of [
      ['output', () => win.takeOutput?.()],
      ['input', () => win.takeInput?.()],
      ['fuel', () => win.takeFuel?.()],
    ]) {
      try {
        const it = await fn();
        if (it) taken[key] = { name: it.name, count: it.count };
      } catch {
        /* */
      }
    }
    return ok('furnace_cleared', { taken });
  } finally {
    try {
      win.close();
    } catch {
      /* */
    }
  }
}

async function useOn(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const toolName = String(args.tool || args.item || args.name || 'hand').toLowerCase();
  const targetName = String(args.target || args.block || args.entity || 'nothing').toLowerCase();

  if (toolName !== 'hand') {
    const tool = findItemByName(bot, toolName);
    if (!tool) fail(`No ${toolName} in inventory`, 'NOT_FOUND');
    await bot.equip(tool, 'hand');
  } else {
    try {
      await bot.unequip('hand');
    } catch {
      /* */
    }
  }

  if (targetName === 'nothing') {
    await bot.activateItem();
    return ok('used', { tool: toolName, target: 'nothing' });
  }

  if (targetName === 'water' || targetName === 'lava') {
    const block = bot.findBlock({
      matching: (b) => b && b.name === targetName && b.metadata === 0,
      maxDistance: Number(args.range || 32),
    });
    if (!block) fail(`No source ${targetName}`, 'NOT_FOUND');
    await nav(ctx, block.position, 2, 20000);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.activateItem();
    return ok('used', { tool: toolName, target: targetName, pos: block.position });
  }

  const ent = nearestEntity(bot, targetName, Number(args.range || 16));
  if (ent) {
    await nav(ctx, ent.position, 2, 20000);
    if (typeof bot.useOn === 'function') await bot.useOn(ent);
    else await bot.activateItem();
    return ok('used', { tool: toolName, target: targetName, entity: ent.id });
  }

  const block = nearestBlock(bot, targetName, Number(args.range || 16));
  if (!block) fail(`No ${targetName} nearby`, 'NOT_FOUND');
  await nav(ctx, block.position, 2, 20000);
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await bot.activateBlock(block);
  return ok('used', { tool: toolName, target: block.name, pos: block.position });
}

async function till(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  let pos;
  if (args.x !== undefined) pos = new Vec3(Number(args.x), Number(args.y), Number(args.z));
  else pos = bot.entity.position.offset(0, -1, 0).floored();
  const block = bot.blockAt(pos);
  if (!block) fail('No block to till', 'NOT_FOUND');
  if (!['grass_block', 'dirt', 'farmland'].includes(block.name)) {
    fail(`Cannot till ${block.name}`, 'BAD_ARGS');
  }
  if (bot.entity.position.distanceTo(block.position) > 4) await nav(ctx, block.position, 2, 15000);
  if (block.name !== 'farmland') {
    const hoe = (bot.inventory.items() || []).find((i) => i.name.includes('hoe'));
    if (!hoe) fail('Need a hoe', 'NOT_FOUND');
    await bot.equip(hoe, 'hand');
    await bot.activateBlock(block);
  }
  return ok('tilled', { pos: { x: pos.x, y: pos.y, z: pos.z } });
}

async function plant(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const seed = mc.seedName(args.seed || args.item || args.name || 'wheat_seeds');
  const item = findItemByName(bot, seed);
  if (!item) fail(`No ${seed}`, 'NOT_FOUND');
  let pos;
  if (args.x !== undefined) pos = new Vec3(Number(args.x), Number(args.y), Number(args.z));
  else pos = bot.entity.position.offset(0, -1, 0).floored();
  let soil = bot.blockAt(pos);
  if (soil && soil.name !== 'farmland') {
    await till(ctx, { x: pos.x, y: pos.y, z: pos.z });
    soil = bot.blockAt(pos);
  }
  if (!soil || soil.name !== 'farmland') fail('Need farmland', 'NOT_FOUND');
  await bot.equip(item, 'hand');
  await bot.activateBlock(soil);
  return ok('planted', { seed, pos: { x: pos.x, y: pos.y, z: pos.z } });
}

async function harvest(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const range = Number(args.range || 12);
  const crops = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart'];
  const want = args.block || args.name;
  const names = want ? [want] : crops;
  const block = bot.findBlock({
    matching: (b) => b && names.includes(b.name) && mc.isMatureCrop(b),
    maxDistance: range,
  });
  if (!block) fail('No mature crop nearby', 'NOT_FOUND');
  await runAction({ type: 'dig', x: block.position.x, y: block.position.y, z: block.position.z });
  return ok('harvested', { block: block.name, pos: block.position });
}

async function goToEntity(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const name = args.name || args.entity || args.mob;
  if (!name) fail('go_to_entity requires name', 'BAD_ARGS');
  const e = nearestEntity(bot, name, Number(args.range || 32));
  if (!e) fail(`No ${name} nearby`, 'NOT_FOUND');
  await nav(ctx, e.position, Number(args.closeness || 2), 20000);
  return ok('arrived_entity', { name: e.name || e.username, id: e.id });
}

function listVillagers(bot, range = 16) {
  const out = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e?.position || e.name !== 'villager') continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d > range) continue;
    out.push({
      id: e.id,
      profession: mc.villagerProfession(e),
      dist: Number(d.toFixed(1)),
      pos: { x: e.position.x, y: e.position.y, z: e.position.z },
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

function tradeItemName(bot, it) {
  if (!it) return null;
  return {
    name: it.name || bot.registry?.items?.[it.id]?.name || String(it.id),
    count: it.count,
  };
}

async function villagerTrades(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const list = listVillagers(bot, Number(args.range || 16));
  let ent = null;
  if (args.id != null) ent = bot.entities[Number(args.id)];
  else if (list[0]) ent = bot.entities[list[0].id];
  if (!ent) fail('No villager nearby', 'NOT_FOUND', { villagers: list });
  if (bot.entity.position.distanceTo(ent.position) > 4) await nav(ctx, ent.position, 2, 20000);
  const win = await bot.openVillager(ent);
  try {
    const trades = (win.trades || []).map((t, i) => ({
      index: i + 1,
      input1: tradeItemName(bot, t.inputItem1),
      input2: tradeItemName(bot, t.inputItem2),
      output: tradeItemName(bot, t.outputItem),
      disabled: Boolean(t.disabled),
    }));
    return ok('villager_trades', {
      id: ent.id,
      profession: mc.villagerProfession(ent),
      trades,
      nearby: list,
    });
  } finally {
    try {
      win.close();
    } catch {
      /* */
    }
  }
}

async function trade(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const id = args.id != null ? Number(args.id) : listVillagers(bot, 16)[0]?.id;
  if (id == null) fail('No villager', 'NOT_FOUND');
  const index = Number(args.index || 1) - 1;
  const count = Number(args.count || 1);
  const ent = bot.entities[id];
  if (!ent) fail(`Villager ${id} gone`, 'NOT_FOUND');
  if (bot.entity.position.distanceTo(ent.position) > 4) await nav(ctx, ent.position, 2, 20000);
  const win = await bot.openVillager(ent);
  try {
    const t = (win.trades || [])[index];
    if (!t) fail(`No trade ${index + 1}`, 'NOT_FOUND');
    if (t.disabled) fail('Trade disabled', 'ERROR');
    if (typeof bot.trade === 'function') await bot.trade(t, count);
    else fail('bot.trade not available', 'ERROR');
    return ok('traded', { id, index: index + 1, count });
  } finally {
    try {
      win.close();
    } catch {
      /* */
    }
  }
}

async function whisper(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const player = args.player || args.to;
  const text = args.text || args.message || args.body;
  if (!player || !text) fail('whisper requires player and text', 'BAD_ARGS');
  if (presence.isSpectator(bot, player)) fail(`${player} is spectating`, 'NOT_FOUND');
  if (typeof bot.whisper === 'function') await bot.whisper(player, String(text).slice(0, 240));
  else await bot.chat(`/msg ${player} ${String(text).slice(0, 200)}`);
  return ok('whispered', { player, text: String(text).slice(0, 240) });
}

async function shoutMeet(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const p = args.x !== undefined ? { x: args.x, y: args.y, z: args.z } : bot.entity.position;
  const line = args.text ? `[meet] ${args.text}` : coord.formatMeet(p);
  await runAction({ type: 'chat', message: line });
  return ok('shouted', { kind: 'meet', text: line, x: p.x, y: p.y, z: p.z });
}

async function shoutTrade(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const need = args.need || args.item;
  const give = args.give;
  if (!need || !give) fail('shout_trade requires need and give', 'BAD_ARGS');
  const line = coord.formatTrade(need, give, args.count);
  await runAction({ type: 'chat', message: line });
  return ok('shouted', { kind: 'trade', text: line, need, give, count: args.count });
}

async function shoutNeed(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const item = args.item || args.need || args.name;
  if (!item) fail('shout_need requires item', 'BAD_ARGS');
  const line = coord.formatNeed(item, args.count);
  await runAction({ type: 'chat', message: line });
  return ok('shouted', { kind: 'need', text: line, item, count: args.count });
}

async function shoutHave(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const item = args.item || args.have || args.name;
  if (!item) fail('shout_have requires item', 'BAD_ARGS');
  const line = coord.formatHave(item, args.count);
  await runAction({ type: 'chat', message: line });
  return ok('shouted', { kind: 'have', text: line, item, count: args.count });
}

async function shoutHelp(ctx, args) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const line = coord.formatHelp(args.text || args.message || args.note);
  await runAction({ type: 'chat', message: line });
  return ok('shouted', { kind: 'help', text: line });
}

async function shoutHere(ctx) {
  const { bot, runAction } = ctx;
  ensureConnected(bot);
  const line = coord.formatHere(bot.entity.position);
  await runAction({ type: 'chat', message: line });
  return ok('shouted', { kind: 'here', text: line });
}

async function bulletin(ctx, args) {
  const { bot } = ctx;
  ensureConnected(bot);
  const tag = String(args.tag || args.kind || 'sign').toLowerCase();
  let text = args.text || args.message;
  if (!text) {
    if (tag === 'meet') text = coord.formatMeet(bot.entity.position);
    else if (tag === 'claim') text = coord.formatClaim(bot.username, args.note || '');
    else if (tag === 'forge') text = `[forge] ${bot.username}`;
    else text = `[${tag}] ${args.note || bot.username}`;
  }
  if (!text.startsWith('[')) text = `[${tag}] ${text}`;
  return writeSign(ctx, { ...args, text });
}

async function mail(ctx, args) {
  const to = args.to || args.player || 'anyone';
  const body = args.text || args.message || args.body;
  if (!body) fail('mail requires text', 'BAD_ARGS');
  const title = coord.mailTitle(to);
  const written = await writeBook(ctx, { text: body, title, author: ctx.bot.username, sign: true });
  if (args.deliver === 'chest' || args.chest) {
    try {
      await putInChest(ctx, { item: 'written_book', count: 1 });
      return ok('mail_chested', { to, title, ...written });
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
    }
  }
  if (args.player || args.deliver === 'give') {
    try {
      await give(ctx, { player: to, item: 'written_book', count: 1 });
      return ok('mail_given', { to, title, ...written });
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
    }
  }
  return ok('mail_written', { to, title, hint: 'toss / put_chest / give to deliver', ...written });
}

async function readMail(ctx) {
  const { bot } = ctx;
  ensureConnected(bot);
  const books = (bot.inventory.items() || []).filter((i) => i.name === 'written_book' || i.name === 'writable_book');
  const letters = [];
  for (const book of books) {
    const nbt = book.nbt?.value || book.nbt || {};
    const title = nbt.title?.value || nbt.title || '';
    if (title && !coord.isMailFor(title, bot.username)) continue;
    let pages = nbt.pages?.value?.value || nbt.pages?.value || nbt.pages || [];
    if (!Array.isArray(pages)) pages = [];
    letters.push({
      title,
      author: nbt.author?.value || nbt.author || null,
      pages: pages.map((p) => bookPageToText(p)),
    });
  }
  return ok('mail_inbox', { letters, count: letters.length });
}

async function lookAround(ctx) {
  const { bot } = ctx;
  ensureConnected(bot);
  return ok('look_around', {
    biome: bot.blockAt(bot.entity.position)?.biome?.name || null,
    weather: mc.weatherOf(bot),
    time: mc.timeOfDay(bot),
    wearing: mc.wearing(bot),
    above_head: mc.firstBlockAboveHead(bot),
    blocks: mc.nearbyBlockTypes(bot, 8),
    players: Object.keys(bot.players).filter(
      (n) => n !== bot.username && !presence.isSpectator(bot, n)
    ),
  });
}

const SKILL_DOCS = {
  gather: 'Collect N of a block (collectBlock + tools + ore aliases)',
  pickup: 'Walk over nearby item entities',
  craft: 'Craft item (walk/place table if needed)',
  craft_plan: 'Recipe steps + missing ingredients from current inventory',
  craftable: 'What can be crafted now (uses table if available)',
  smelt: 'Smelt item in nearby/placed furnace',
  clear_furnace: 'Empty furnace input/fuel/output',
  use_on: 'Use tool on nothing/block/entity/source liquid',
  till: 'Hoe dirt/grass into farmland',
  plant: 'Plant seeds on farmland',
  harvest: 'Break a mature crop',
  goto: 'Path to x,y,z',
  go_to_player: 'Soft walk toward a visible player (same as go_find)',
  go_find: 'Find a player by sight, last coords, or torch/dig traces; loose circle arrive',
  peers: 'Last heard / seen positions of other players',
  emote: 'jump / sneak / wave / point (look at block + 这个)',
  go_to_block: 'Find nearest block type and walk to it',
  go_to_entity: 'Walk to nearest named entity',
  move_away: 'Path randomly away',
  follow: 'Follow player for duration_ms',
  give: 'Approach, toss, wait for playerCollect',
  equip: 'Equip item',
  discard: 'Toss item',
  consume: 'Eat/drink food',
  attack: 'One swing at player/mob/nearest (kill=true → hunt)',
  hunt: 'Chase and melee until dead; pickup drops. name/count/range',
  defend: 'Clear nearby hostiles (creeper kite, then pickup)',
  sleep: 'Find bed and sleep',
  stay: 'Stand still N seconds',
  place_here: 'Place block near feet',
  dig_down: 'Dig downward carefully',
  surface: 'Climb using column scan',
  wrap_up: 'End-of-turn: stop danger, leave water, eat if low, walk to light',
  view_chest: 'Open nearest chest and list contents',
  put_chest: 'Deposit item into nearest chest',
  take_chest: 'Withdraw item from nearest chest',
  write_sign: 'Write/place a sign (async public note)',
  read_sign: 'Read nearest sign text',
  find_signs: 'List nearby signs + text (range)',
  bulletin: 'Write a tagged sign [meet]/[claim]/[forge]',
  write_book: 'Write/sign a writable_book',
  read_book: 'Read a book in inventory',
  mail: 'Sign a book titled To:Name (optional give/chest)',
  read_mail: 'Read books addressed To:you / anyone',
  remember_here: 'Save current coords (private)',
  go_place: 'Path to a remembered place',
  forget_place: 'Delete a remembered place',
  places: 'List remembered places (private)',
  villager_trades: 'List trades for nearest/id villager',
  trade: 'Execute villager trade index',
  activate: 'Right-click block (door, button, …)',
  look_player: 'Look at a player',
  look_around: 'Biome/weather/time/armor/nearby blocks',
  inventory: 'Inventory summary',
  say: 'Public chat',
  whisper: 'Private /msg',
  shout_meet: 'Chat [meet] + coords',
  shout_trade: 'Chat [trade] need: give:',
  shout_need: 'Chat [need] item',
  shout_have: 'Chat [have] item',
  shout_help: 'Chat [help]',
  shout_here: 'Chat [here] + coords',
  help: 'List skills',
};

async function help() {
  return ok('skills', { skills: SKILL_DOCS });
}

/**
 * @param {string} name
 * @param {object} ctx  { bot, runAction, config, places }
 * @param {object} args
 */
async function runSkill(name, ctxOrBot, runActionOrArgs, maybeArgs) {
  // Back-compat: runSkill(name, bot, runAction, args)
  let ctx;
  let args;
  if (ctxOrBot && ctxOrBot.bot) {
    ctx = ctxOrBot;
    args = runActionOrArgs || {};
  } else {
    ctx = {
      bot: ctxOrBot,
      runAction: runActionOrArgs,
      config: maybeArgs?.config || {},
      places: maybeArgs?.places,
      peers: maybeArgs?.peers,
      soul: maybeArgs?.soul,
      sense: maybeArgs?.sense,
      signal: maybeArgs?.signal,
    };
    args = maybeArgs || {};
  }

  const n = String(name || '')
    .toLowerCase()
    .replace(/^!/, '')
    .replace(/-/g, '_');

  const table = {
    help,
    gather,
    gather_block: gather,
    collect: gather,
    collect_blocks: gather,
    pickup,
    pickup_nearby: pickup,
    craft,
    craft_recipe: craft,
    craft_plan: craftPlan,
    get_crafting_plan: craftPlan,
    smelt,
    smelt_item: smelt,
    clear_furnace: clearFurnace,
    use_on: useOn,
    useon: useOn,
    till,
    plant,
    harvest,
    go_to_entity: goToEntity,
    search_for_entity: goToEntity,
    villager_trades: villagerTrades,
    show_villager_trades: villagerTrades,
    trade,
    trade_with_villager: trade,
    whisper,
    shout_meet: shoutMeet,
    shout_trade: shoutTrade,
    shout_need: shoutNeed,
    shout_have: shoutHave,
    shout_help: shoutHelp,
    shout_here: shoutHere,
    bulletin,
    mail,
    write_mail: mail,
    read_mail: readMail,
    look_around: lookAround,
    goto: goTo,
    go: goTo,
    come: goTo,
    go_to_coordinates: goTo,
    go_to_player: goToPlayer,
    goto_player: goToPlayer,
    go_find: goFind,
    find: goFind,
    find_player: goFind,
    peers: listPeers,
    emote: doEmote,
    wave: (ctx, a) => doEmote(ctx, { ...a, kind: 'wave' }),
    point: (ctx, a) => doEmote(ctx, { ...a, kind: 'point' }),
    last_seen: listPeers,
    go_to_block: goToBlock,
    search_for_block: goToBlock,
    move_away: moveAway,
    follow,
    follow_player: follow,
    give,
    give_player: give,
    equip,
    discard,
    toss: discard,
    consume,
    eat: consume,
    attack,
    hunt,
    kill: hunt,
    fight: hunt,
    defend,
    defend_self: defend,
    sleep: goToBed,
    go_to_bed: goToBed,
    stay,
    place_here: placeHere,
    dig_down: digDown,
    surface: goToSurface,
    go_to_surface: goToSurface,
    wrap_up: wrapUp,
    wrapup: wrapUp,
    settle: wrapUp,
    view_chest: viewChest,
    put_chest: putInChest,
    put_in_chest: putInChest,
    take_chest: takeFromChest,
    take_from_chest: takeFromChest,
    write_sign: writeSign,
    read_sign: readSign,
    find_signs: findSigns,
    scan_signs: findSigns,
    write_book: writeBook,
    read_book: readBook,
    remember_here: rememberHere,
    remember: rememberHere,
    go_place: goToPlace,
    go_to_place: goToPlace,
    forget_place: forgetPlace,
    forget: forgetPlace,
    places: listPlaces,
    list_places: listPlaces,
    activate,
    look_player: lookAtPlayer,
    inventory,
    inv: inventory,
    say,
    craftable,
  };

  const fn = table[n];
  if (!fn) {
    fail(`Unknown skill: ${name}. Use skill help`, 'BAD_ARGS', {
      known: Object.keys(SKILL_DOCS),
    });
  }
  return fn(ctx, args);
}

module.exports = {
  runSkill,
  countItem,
  invSummary,
  SKILL_DOCS,
  signTextOf,
};
