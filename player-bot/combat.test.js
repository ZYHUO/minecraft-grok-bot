'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { weaponScore, desiredGap, isBaby, hasNametag, findTarget } = require('./combat');

test('weaponScore prefers swords', () => {
  const sword = { name: 'iron_sword', attackDamage: 6 };
  const axe = { name: 'iron_axe', attackDamage: 9 };
  const pick = { name: 'iron_pickaxe', attackDamage: 4 };
  assert.ok(weaponScore(sword) > weaponScore(pick));
  assert.ok(weaponScore(axe) > weaponScore(pick));
  assert.ok(weaponScore(sword) > 0);
});

test('desiredGap kites creepers', () => {
  const c = desiredGap('creeper');
  const z = desiredGap('zombie');
  assert.ok(c.min >= 4);
  assert.ok(c.follow > z.follow);
  assert.ok(z.max < 4);
});

test('isBaby reads metadata and height', () => {
  assert.equal(isBaby({ name: 'sheep', metadata: { 16: true }, height: 1.3 }), true);
  assert.equal(isBaby({ name: 'sheep', metadata: [], height: 1.3 }), false);
  assert.equal(isBaby({ name: 'sheep', metadata: [], height: 0.4 }), true);
});

test('hasNametag', () => {
  assert.equal(hasNametag({ name: 'wolf', username: '旺财' }), true);
  assert.equal(hasNametag({ name: 'sheep' }), false);
});

function mockBot(entities) {
  return {
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    players: {},
  };
}

test('findTarget skips babies and prefers closest huntable', () => {
  const bot = mockBot({
    1: { id: 1, name: 'sheep', type: 'animal', position: new Vec3(5, 64, 0), height: 1.3, metadata: [] },
    2: { id: 2, name: 'sheep', type: 'animal', position: new Vec3(2, 64, 0), height: 0.4, metadata: { 16: true } },
    3: { id: 3, name: 'zombie', type: 'mob', position: new Vec3(3, 64, 0), height: 1.9, metadata: [] },
  });
  const sheep = findTarget(bot, { prefer: 'huntable', range: 16, skipBaby: true });
  assert.equal(sheep && sheep.id, 1);
  const hostile = findTarget(bot, { prefer: 'hostile', range: 16 });
  assert.equal(hostile && hostile.id, 3);
  const named = findTarget(bot, { name: 'zombie', range: 16 });
  assert.equal(named && named.id, 3);
});

test('findTarget by entity_id', () => {
  const bot = mockBot({
    9: { id: 9, name: 'cow', position: new Vec3(4, 64, 0), height: 1.4, metadata: [] },
  });
  assert.equal(findTarget(bot, { entity_id: 9 }).id, 9);
});
