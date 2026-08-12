'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadSoul } = require('./soul');

test('play rule is locked and on status soul', () => {
  const s = loadSoul(path.join(__dirname, '../souls/andy.toml'));
  assert.equal(s.play.stay_in_world, true);
  assert.match(s.play.rule, /wrap_up/);
  assert.match(s.play.rule, /上岸/);
});

test('toml cannot overwrite play.rule', () => {
  const s = loadSoul(path.join(__dirname, '../souls/wild.toml'));
  assert.match(s.play.rule, /保命续玩/);
});

test('play.path is locked and wrap_up rule stays short', () => {
  const s = loadSoul(path.join(__dirname, '../souls/andy.toml'));
  assert.match(s.play.path, /中间点/);
  assert.doesNotMatch(s.play.rule, /decide path/);
});
