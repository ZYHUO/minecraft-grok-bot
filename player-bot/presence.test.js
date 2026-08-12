'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { asVec3, inWater, findShore } = require('./presence');

test('asVec3 upgrades plain xyz so floored exists', () => {
  const v = asVec3({ x: 1.2, y: 64.9, z: -3 });
  assert.equal(typeof v.floored, 'function');
  const f = v.floored();
  assert.equal(f.x, 1);
  assert.equal(f.y, 64);
  assert.equal(f.z, -3);
  const same = asVec3(new Vec3(2, 3, 4));
  assert.equal(same.x, 2);
});

function worldBot(map, pos, isInWater) {
  return {
    entity: { position: pos, isInWater: Boolean(isInWater) },
    blockAt(p) {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      const name = map[k] || 'air';
      return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
    },
  };
}

test('findShore finds bank one block above water Y', () => {
  const map = {
    '0,64,0': 'water',
    '0,63,0': 'water',
    '0,62,0': 'sand',
    '3,65,0': 'air',
    '3,66,0': 'air',
    '3,64,0': 'sand',
  };
  const bot = worldBot(map, new Vec3(0.5, 64.2, 0.5), true);
  const shore = findShore(bot, 8);
  assert.ok(shore);
  assert.equal(shore.x, 3);
  assert.equal(shore.y, 65);
});

test('inWater is true when standing in water', () => {
  const map = { '0,64,0': 'water', '0,65,0': 'air' };
  const bot = worldBot(map, new Vec3(0.5, 64.1, 0.5), false);
  assert.equal(inWater(bot), true);
});
