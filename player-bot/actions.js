'use strict';

const { Vec3 } = require('vec3');
const {
  goals: { GoalNear, GoalFollow },
  Movements,
} = require('mineflayer-pathfinder');
const { isSpectator } = require('./presence');

/**
 * Action executor for Mineflayer.
 * Long-running actions resolve when done; caller manages job state + stop.
 */

function num(v, name) {
  const n = Number(v);
  if (Number.isNaN(n)) {
    const err = new Error(`Invalid number for ${name}: ${v}`);
    err.code = 'BAD_ARGS';
    throw err;
  }
  return n;
}

function vecFromBody(body) {
  if (body.x === undefined || body.y === undefined || body.z === undefined) {
    const err = new Error('Requires x, y, z');
    err.code = 'BAD_ARGS';
    throw err;
  }
  return new Vec3(num(body.x, 'x'), num(body.y, 'y'), num(body.z, 'z'));
}

/**
 * Exact name first; then unique partial match. Ambiguous partial → error.
 */
function findItemByName(bot, name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  const items = bot.inventory.items();
  const exact = items.find((i) => i.name === lower);
  if (exact) return exact;

  const partial = items.filter(
    (i) => i.name.includes(lower) || i.name.endsWith('_' + lower)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const names = [...new Set(partial.map((i) => i.name))].join(', ');
    const err = new Error(`Ambiguous item "${name}": matches ${names}. Use exact name.`);
    err.code = 'BAD_ARGS';
    throw err;
  }
  return null;
}

function setupMovements(bot) {
  const movements = new Movements(bot);
  const style = bot._soul?.gait?.style;
  const sprint = bot._soul?.gait?.sprint;
  movements.allowSprinting = sprint ?? style === 'sprint';
  movements.canDig = true;
  return movements;
}

/**
 * Cancel pathfinder + any active dig.
 */
async function stopAll(bot) {
  if (!bot) return;
  try {
    bot.pathfinder?.setGoal?.(null);
  } catch {
    /* ignore */
  }
  try {
    bot.pathfinder?.stop?.();
  } catch {
    /* ignore */
  }
  try {
    bot.clearControlStates();
  } catch {
    /* ignore */
  }
  try {
    if (bot.targetDigBlock) {
      bot.stopDigging();
    }
  } catch {
    /* ignore */
  }
}

function abortedError() {
  const err = new Error('Aborted');
  err.code = 'ABORTED';
  return err;
}

function timeoutError(msg = 'Timeout') {
  const err = new Error(msg);
  err.code = 'TIMEOUT';
  return err;
}

function noPathError(msg = 'No path to target') {
  const err = new Error(msg);
  err.code = 'NO_PATH';
  return err;
}

/**
 * Race a promise against abort signal + optional timeout.
 */
function withAbortAndTimeout(promise, signal, timeoutMs, label = 'operation') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }

    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    const onAbort = () => finish(reject, abortedError());

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => finish(reject, timeoutError(`${label} timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(promise).then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e)
    );
  });
}

/**
 * Navigate with pathfinder.goto when available; fallback to GoalNear + events.
 * Does NOT require onGround (works in water / mid-air / ladders).
 */
async function navigateTo(bot, config, pos, range, timeoutMs, signal) {
  bot.pathfinder.setMovements(setupMovements(bot));
  const goal = new GoalNear(pos.x, pos.y, pos.z, range);

  // Prefer promise API if present (mineflayer-pathfinder)
  if (typeof bot.pathfinder.goto === 'function') {
    try {
      await withAbortAndTimeout(bot.pathfinder.goto(goal), signal, timeoutMs, 'move_to');
    } catch (e) {
      await stopAll(bot);
      // Normalize pathfinder errors
      const msg = String(e?.message || e || '');
      if (e?.code === 'ABORTED' || e?.code === 'TIMEOUT') throw e;
      if (/no path|path.?stopped|unreachable|canceled|cancelled/i.test(msg)) {
        throw noPathError(msg || 'No path to target');
      }
      // pathfinder often throws Error with name
      if (e?.name === 'NoPath' || e?.name === 'Timeout') {
        const err = new Error(msg || e.name);
        err.code = e.name === 'Timeout' ? 'TIMEOUT' : 'NO_PATH';
        throw err;
      }
      throw e;
    }
    await stopAll(bot);
    return;
  }

  // Fallback: setGoal + listen for goal_reached / path events
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      bot.removeListener('goal_reached', onReached);
      bot.removeListener('path_update', onPathUpdate);
      bot.removeListener('goal_updated', onGoalUpdated);
      bot.removeListener('physicsTick', onTick);
    };

    const fail = (err) => {
      cleanup();
      reject(err);
    };
    const ok = () => {
      cleanup();
      resolve(true);
    };

    const onAbort = () => fail(abortedError());
    const onReached = () => ok();
    const onPathUpdate = (r) => {
      // status: 'noPath' | 'timeout' | 'partialPath' | ...
      if (r?.status === 'noPath') fail(noPathError());
      if (r?.status === 'timeout') fail(timeoutError('pathfinder timeout'));
    };
    const onGoalUpdated = () => {
      /* ignore */
    };
    const onTick = () => {
      if (!bot.entity) return;
      const d = bot.entity.position.distanceTo(pos);
      // Distance only — no onGround requirement
      if (d <= range + 0.5) ok();
    };

    const timer = setTimeout(() => fail(timeoutError('move_to timeout')), timeoutMs);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    bot.on('goal_reached', onReached);
    bot.on('path_update', onPathUpdate);
    bot.on('goal_updated', onGoalUpdated);
    bot.on('physicsTick', onTick);

    try {
      bot.pathfinder.setGoal(goal);
    } catch (e) {
      fail(e);
    }
  });

  await stopAll(bot);
}

/**
 * Axis-aligned unit face vector from reference block toward target cell.
 */
function faceVectorTo(refPos, targetPos) {
  const dx = Math.sign(targetPos.x - refPos.x);
  const dy = Math.sign(targetPos.y - refPos.y);
  const dz = Math.sign(targetPos.z - refPos.z);
  // Prefer single-axis (mineflayer placeBlock wants one face)
  if (dy !== 0 && dx === 0 && dz === 0) return new Vec3(0, dy, 0);
  if (dx !== 0 && dy === 0 && dz === 0) return new Vec3(dx, 0, 0);
  if (dz !== 0 && dx === 0 && dy === 0) return new Vec3(0, 0, dz);
  // Multi-axis: prefer up/down, then x, then z
  if (dy !== 0) return new Vec3(0, dy, 0);
  if (dx !== 0) return new Vec3(dx, 0, 0);
  if (dz !== 0) return new Vec3(0, 0, dz);
  return new Vec3(0, 1, 0);
}

function isAirName(name) {
  return !name || name === 'air' || name === 'cave_air' || name === 'void_air';
}

/**
 * Execute one action.
 * @returns {Promise<{ ok: boolean, message?: string, result?: any }>}
 */
async function executeAction(bot, config, body, signal) {
  const type = String(body.type || body.action || '').toLowerCase().trim();
  if (!type) {
    const err = new Error('Missing action type');
    err.code = 'BAD_ARGS';
    throw err;
  }

  if (!bot?.entity && type !== 'stop') {
    const err = new Error('Bot not connected to Minecraft');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  switch (type) {
    case 'stop': {
      await stopAll(bot);
      return { ok: true, message: 'stopped' };
    }

    case 'chat': {
      const message = body.message ?? body.text ?? body.msg;
      if (message === undefined || message === null || message === '') {
        const err = new Error('chat requires message');
        err.code = 'BAD_ARGS';
        throw err;
      }
      await bot.chat(String(message).slice(0, 256));
      return { ok: true, message: 'chat_sent' };
    }

    case 'look_at': {
      const pos = vecFromBody(body);
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
      return { ok: true, message: 'looked' };
    }

    case 'move_to': {
      const pos = vecFromBody(body);
      const range = body.range !== undefined ? num(body.range, 'range') : config.moveRange;
      const timeout =
        body.timeout_ms !== undefined
          ? num(body.timeout_ms, 'timeout_ms')
          : config.moveTimeoutMs;

      try {
        await navigateTo(bot, config, pos, range, timeout, signal);
        return {
          ok: true,
          message: 'arrived',
          result: {
            pos: {
              x: bot.entity.position.x,
              y: bot.entity.position.y,
              z: bot.entity.position.z,
            },
          },
        };
      } catch (e) {
        await stopAll(bot);
        throw e;
      }
    }

    case 'follow_player': {
      const name = body.player || body.name || body.target;
      if (!name) {
        const err = new Error('follow_player requires player');
        err.code = 'BAD_ARGS';
        throw err;
      }
      if (isSpectator(bot, name)) {
        const err = new Error(`Player is spectating: ${name}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      const target = bot.players[name]?.entity;
      if (!target) {
        const err = new Error(`Player not found or not visible: ${name}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      const range = body.range !== undefined ? num(body.range, 'range') : 2;
      const timeout =
        body.timeout_ms !== undefined
          ? num(body.timeout_ms, 'timeout_ms')
          : config.moveTimeoutMs;

      bot.pathfinder.setMovements(setupMovements(bot));
      bot.pathfinder.setGoal(new GoalFollow(target, range), true);

      try {
        await withAbortAndTimeout(
          new Promise(() => {
            /* run until timeout/abort */
          }),
          signal,
          timeout,
          'follow_player'
        );
      } catch (e) {
        await stopAll(bot);
        if (e.code === 'TIMEOUT') {
          return { ok: true, message: 'follow_ended_timeout' };
        }
        throw e;
      }
      await stopAll(bot);
      return { ok: true, message: 'follow_stopped' };
    }

    case 'dig': {
      let block = null;
      if (body.x !== undefined && body.y !== undefined && body.z !== undefined) {
        const pos = vecFromBody(body);
        block = bot.blockAt(pos);
      } else if (body.block || body.name) {
        const want = String(body.block || body.name).toLowerCase();
        const maxDist =
          body.max_distance !== undefined
            ? num(body.max_distance, 'max_distance')
            : config.digDistance;
        block = bot.findBlock({
          matching: (b) => b && b.name === want,
          maxDistance: maxDist,
        });
      } else {
        block = bot.blockAtCursor?.(config.digDistance) || null;
      }

      if (!block || isAirName(block.name)) {
        const err = new Error('No diggable block found');
        err.code = 'NOT_FOUND';
        throw err;
      }

      try {
        if (bot.tool?.equipForBlock) {
          await bot.tool.equipForBlock(block, {});
        }
      } catch {
        /* optional */
      }

      const dist = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5));
      if (dist > config.digDistance) {
        try {
          await navigateTo(
            bot,
            config,
            block.position,
            2,
            config.moveTimeoutMs,
            signal
          );
        } catch (e) {
          await stopAll(bot);
          throw e;
        }
      }

      if (signal?.aborted) throw abortedError();

      const timeout =
        body.timeout_ms !== undefined
          ? num(body.timeout_ms, 'timeout_ms')
          : config.digTimeoutMs;

      try {
        await withAbortAndTimeout(
          (async () => {
            try {
              await bot.dig(block);
            } catch (e) {
              // stopDigging / abort surfaces as errors — rethrow with code if needed
              throw e;
            }
          })(),
          signal,
          timeout,
          'dig'
        );
      } catch (e) {
        try {
          bot.stopDigging();
        } catch {
          /* ignore */
        }
        if (e.code === 'TIMEOUT' || e.code === 'ABORTED') throw e;
        throw e;
      }

      return {
        ok: true,
        message: 'dug',
        result: {
          block: block.name,
          pos: { x: block.position.x, y: block.position.y, z: block.position.z },
        },
      };
    }

    case 'place': {
      const itemName = body.item || body.block || body.name;
      if (!itemName) {
        const err = new Error('place requires item');
        err.code = 'BAD_ARGS';
        throw err;
      }
      const item = findItemByName(bot, itemName);
      if (!item) {
        const err = new Error(`Item not in inventory: ${itemName}`);
        err.code = 'NOT_FOUND';
        throw err;
      }

      // Target cell to fill with the block
      const targetCell = vecFromBody(body).floored();
      const existing = bot.blockAt(targetCell);
      if (existing && !isAirName(existing.name)) {
        const err = new Error(
          `Target occupied by ${existing.name} at ${targetCell.x},${targetCell.y},${targetCell.z}`
        );
        err.code = 'BAD_ARGS';
        throw err;
      }

      // Optional explicit face: up|down|north|south|east|west
      const faceName = body.face ? String(body.face).toLowerCase() : null;
      const faceOffsets = {
        up: [0, -1, 0],
        down: [0, 1, 0],
        north: [0, 0, 1],
        south: [0, 0, -1],
        west: [1, 0, 0],
        east: [-1, 0, 0],
      };

      let refBlock = null;
      let faceVec = null;

      if (faceName && faceOffsets[faceName]) {
        const [ox, oy, oz] = faceOffsets[faceName];
        // face "up" means place on top of block below target
        refBlock = bot.blockAt(targetCell.offset(ox, oy, oz));
        if (refBlock && !isAirName(refBlock.name)) {
          faceVec = new Vec3(-ox, -oy, -oz);
        }
      }

      if (!refBlock) {
        const neighbors = [
          [0, -1, 0], // below → place up
          [0, 1, 0],
          [1, 0, 0],
          [-1, 0, 0],
          [0, 0, 1],
          [0, 0, -1],
        ];
        for (const [dx, dy, dz] of neighbors) {
          const b = bot.blockAt(targetCell.offset(dx, dy, dz));
          if (b && !isAirName(b.name)) {
            refBlock = b;
            faceVec = faceVectorTo(b.position, targetCell);
            break;
          }
        }
      }

      if (!refBlock || !faceVec) {
        const err = new Error('No solid reference block adjacent to place target');
        err.code = 'NOT_FOUND';
        throw err;
      }

      // Ensure unit axis face
      faceVec = new Vec3(Math.sign(faceVec.x), Math.sign(faceVec.y), Math.sign(faceVec.z));
      if (faceVec.x === 0 && faceVec.y === 0 && faceVec.z === 0) {
        faceVec = new Vec3(0, 1, 0);
      }

      await bot.equip(item, 'hand');

      const dist = bot.entity.position.distanceTo(targetCell.offset(0.5, 0.5, 0.5));
      if (dist > config.placeDistance) {
        try {
          await navigateTo(bot, config, targetCell, 2, config.moveTimeoutMs, signal);
        } catch (e) {
          await stopAll(bot);
          throw e;
        }
      }

      if (signal?.aborted) throw abortedError();

      await bot.placeBlock(refBlock, faceVec);
      return {
        ok: true,
        message: 'placed',
        result: {
          item: item.name,
          pos: { x: targetCell.x, y: targetCell.y, z: targetCell.z },
          against: {
            x: refBlock.position.x,
            y: refBlock.position.y,
            z: refBlock.position.z,
          },
        },
      };
    }

    case 'equip': {
      const itemName = body.item || body.name;
      const destination = body.destination || body.slot || 'hand';
      if (!itemName) {
        const err = new Error('equip requires item');
        err.code = 'BAD_ARGS';
        throw err;
      }
      const item = findItemByName(bot, itemName);
      if (!item) {
        const err = new Error(`Item not in inventory: ${itemName}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      await bot.equip(item, destination);
      return { ok: true, message: 'equipped', result: { item: item.name, destination } };
    }

    case 'unequip': {
      const destination = body.destination || body.slot || 'hand';
      await bot.unequip(destination);
      return { ok: true, message: 'unequipped', result: { destination } };
    }

    case 'craft': {
      const itemName = body.item || body.name;
      const count = body.count !== undefined ? num(body.count, 'count') : 1;
      if (!itemName) {
        const err = new Error('craft requires item');
        err.code = 'BAD_ARGS';
        throw err;
      }

      const mcData = require('minecraft-data')(bot.version);
      const item = mcData.itemsByName[String(itemName).toLowerCase()];
      if (!item) {
        const err = new Error(`Unknown item: ${itemName}`);
        err.code = 'BAD_ARGS';
        throw err;
      }

      const timeout =
        body.timeout_ms !== undefined
          ? num(body.timeout_ms, 'timeout_ms')
          : config.craftTimeoutMs;

      const doCraft = async () => {
        const recipes = bot.recipesFor(item.id, null, 1, null);
        let recipe = recipes.find((r) => r.requiresTable === false) || recipes[0];

        if (!recipe) {
          const table = bot.findBlock({
            matching: mcData.blocksByName.crafting_table?.id,
            maxDistance: 4,
          });
          const recipesWithTable = bot.recipesFor(item.id, null, 1, table || true);
          recipe = recipesWithTable[0];
          if (!recipe) {
            const err = new Error(`No recipe or missing ingredients for ${itemName}`);
            err.code = 'NOT_FOUND';
            throw err;
          }
          await bot.craft(recipe, count, table || null);
        } else {
          await bot.craft(recipe, count, null);
        }
      };

      await withAbortAndTimeout(doCraft(), signal, timeout, 'craft');

      return {
        ok: true,
        message: 'crafted',
        result: { item: item.name, count },
      };
    }

    case 'attack': {
      let entity = null;
      if (body.entity_id !== undefined) {
        entity = bot.entities[Number(body.entity_id)];
      } else if (body.player || body.name) {
        const name = body.player || body.name;
        if (isSpectator(bot, name)) {
          const err = new Error(`Player is spectating: ${name}`);
          err.code = 'NOT_FOUND';
          throw err;
        }
        entity = bot.players[name]?.entity || null;
        if (!entity) {
          const want = String(name).toLowerCase();
          let best = null;
          let bestD = Infinity;
          for (const id of Object.keys(bot.entities)) {
            const e = bot.entities[id];
            if (!e?.position || e === bot.entity) continue;
            const n = (e.name || '').toLowerCase();
            if (n !== want && !n.includes(want)) continue;
            const d = bot.entity.position.distanceTo(e.position);
            if (d < bestD) {
              bestD = d;
              best = e;
            }
          }
          entity = best;
        }
      } else {
        let best = null;
        let bestD = Infinity;
        for (const id of Object.keys(bot.entities)) {
          const e = bot.entities[id];
          if (!e?.position || e === bot.entity || e.type === 'player') continue;
          const d = bot.entity.position.distanceTo(e.position);
          if (d < bestD && d <= config.attackDistance + 2) {
            bestD = d;
            best = e;
          }
        }
        entity = best;
      }

      if (!entity) {
        const err = new Error('No attack target found');
        err.code = 'NOT_FOUND';
        throw err;
      }

      await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0), true);
      await bot.attack(entity);
      return {
        ok: true,
        message: 'attacked',
        result: {
          id: entity.id,
          name: entity.name || entity.username || entity.type,
        },
      };
    }

    case 'toss': {
      const itemName = body.item || body.name;
      const count = body.count !== undefined ? num(body.count, 'count') : 1;
      if (!itemName) {
        const err = new Error('toss requires item');
        err.code = 'BAD_ARGS';
        throw err;
      }
      const item = findItemByName(bot, itemName);
      if (!item) {
        const err = new Error(`Item not in inventory: ${itemName}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      await bot.toss(item.type, null, Math.min(count, item.count));
      return { ok: true, message: 'tossed', result: { item: item.name, count } };
    }

    case 'set_control': {
      const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
      for (const k of keys) {
        if (body[k] !== undefined) {
          bot.setControlState(k, Boolean(body[k]));
        }
      }
      return { ok: true, message: 'controls_set' };
    }

    case 'activate_item': {
      bot.activateItem();
      return { ok: true, message: 'activated_item' };
    }

    case 'deactivate_item': {
      bot.deactivateItem();
      return { ok: true, message: 'deactivated_item' };
    }

    default: {
      const err = new Error(`Unknown action type: ${type}`);
      err.code = 'BAD_ARGS';
      throw err;
    }
  }
}

module.exports = {
  executeAction,
  stopAll,
  navigateTo,
  findItemByName,
};
