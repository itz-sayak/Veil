const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MODES, getActiveMode, getActiveModePrompt } = require('../src/modes');

test('ships the Cluely-style built-in modes', () => {
  const ids = DEFAULT_MODES.map((m) => m.id);
  for (const id of ['default', 'general', 'job', 'user']) {
    assert.ok(ids.includes(id), `missing built-in mode: ${id}`);
  }
  assert.ok(DEFAULT_MODES.every((m) => m.builtin === true));
});

test('getActiveMode falls back to the general mode when nothing is set', () => {
  const m = getActiveMode({});
  assert.equal(m.id, 'general');
});

test('getActiveMode honours the active id', () => {
  const settings = { modes: { activeId: 'job', list: DEFAULT_MODES } };
  assert.equal(getActiveMode(settings).id, 'job');
});

test('Default mode contributes an empty prompt (no persona injection)', () => {
  const settings = { modes: { activeId: 'default', list: DEFAULT_MODES } };
  assert.equal(getActiveModePrompt(settings), '');
});

test('a non-default mode contributes a non-empty system prompt', () => {
  const settings = { modes: { activeId: 'job', list: DEFAULT_MODES } };
  assert.ok(getActiveModePrompt(settings).length > 0);
});

test('a custom user mode prompt is returned verbatim (trimmed)', () => {
  const settings = {
    modes: {
      activeId: 'mine',
      list: [{ id: 'mine', name: 'Mine', builtin: false, systemPrompt: '  be terse  ' }]
    }
  };
  assert.equal(getActiveModePrompt(settings), 'be terse');
});
