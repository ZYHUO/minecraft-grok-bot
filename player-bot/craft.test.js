'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('./mcdata');

const bot = {
  registry: {
    itemsByName: {
      crafting_table: { id: 278 },
      oak_planks: { id: 23 },
      spruce_planks: { id: 24 },
      oak_log: { id: 110 },
      stick: { id: 807 },
    },
  },
};

test('resolveItemName aliases', () => {
  assert.equal(mc.resolveItemName(bot, 'workbench'), 'crafting_table');
  assert.equal(mc.resolveItemName(bot, '工作台'), 'crafting_table');
  assert.equal(mc.resolveItemName(bot, 'sticks'), 'stick');
  assert.equal(mc.resolveItemName(bot, 'oak-planks'), 'oak_planks');
});

test('craftBatches is item count not recipe times', () => {
  assert.equal(mc.craftBatches(8, 4), 2);
  assert.equal(mc.craftBatches(1, 1), 1);
  assert.equal(mc.craftBatches(5, 4), 2);
});

test('maxCrafts from recipe delta', () => {
  const fake = {
    inventory: {
      count(id) {
        if (id === 23) return 5;
        return 0;
      },
    },
  };
  const recipe = { delta: [{ id: 23, count: -4 }, { id: 278, count: 1 }] };
  assert.equal(mc.maxCrafts(fake, recipe), 1);
});

test('isPlankName / isLogName', () => {
  assert.equal(mc.isPlankName('oak_planks'), true);
  assert.equal(mc.isLogName('oak_log'), true);
  assert.equal(mc.isLogName('oak_planks'), false);
});
