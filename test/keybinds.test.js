const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_KEYBINDS, KEYBIND_META, isValidAccelerator } = require('../src/keybinds');

test('every action in the metadata has a default binding', () => {
  for (const item of KEYBIND_META) {
    assert.ok(DEFAULT_KEYBINDS[item.action], `no default for ${item.action}`);
  }
});

test('accepts valid Electron accelerators', () => {
  const good = [
    'CommandOrControl+Return',
    'CommandOrControl+Shift+\\',
    'CommandOrControl+Up',
    'Alt+Shift+H',
    'F5',
    'CommandOrControl+Shift+X',
  ];
  for (const a of good) assert.ok(isValidAccelerator(a), `should accept ${a}`);
});

test('rejects garbage and modifier-only accelerators', () => {
  const bad = ['', 'Ctrl+', 'NotAModifier+A', 'Shift', null, undefined, 42];
  for (const a of bad) assert.ok(!isValidAccelerator(a), `should reject ${String(a)}`);
});

test('all default bindings are themselves valid', () => {
  for (const [action, accel] of Object.entries(DEFAULT_KEYBINDS)) {
    assert.ok(isValidAccelerator(accel), `default ${action} (${accel}) should be valid`);
  }
});
