// keybinds.js — shared keybinding defaults + metadata.
// Accelerators use Electron's format (https://www.electronjs.org/docs/latest/api/accelerator).
// Both the main process (globalShortcut) and the renderer (Keybinds UI) import this
// so there is a single source of truth for the default shortcuts.

// Defaults are chosen to register reliably: the bare `\` key and bare Ctrl+Arrow
// combos are frequently already held by the OS / other apps (so globalShortcut
// can't grab them), whereas Ctrl+Alt+… and Ctrl+Shift+… combos are usually free.
const DEFAULT_KEYBINDS = {
  // General
  toggleVisibility: 'CommandOrControl+Alt+V',
  assist:           'CommandOrControl+Return',
  say:              'CommandOrControl+Shift+Return',
  leetcode:         'CommandOrControl+H',
  clearChat:        'CommandOrControl+R',
  session:          'CommandOrControl+Alt+L',
  stealth:          'CommandOrControl+Alt+U',
  quit:             'CommandOrControl+Shift+X',
  // Window
  moveUp:           'CommandOrControl+Alt+Up',
  moveDown:         'CommandOrControl+Alt+Down',
  moveLeft:         'CommandOrControl+Alt+Left',
  moveRight:        'CommandOrControl+Alt+Right',
  // Scroll
  scrollUp:         'CommandOrControl+Shift+Up',
  scrollDown:       'CommandOrControl+Shift+Down',
};

// Old defaults that fail to register on many machines. Persisted copies of these
// exact values are upgraded to the new defaults on load (see src/store.js).
const LEGACY_BAD_KEYBINDS = {
  toggleVisibility: 'CommandOrControl+\\',
  session:          'CommandOrControl+Shift+\\',
  moveUp:           'CommandOrControl+Up',
  moveDown:         'CommandOrControl+Down',
  moveLeft:         'CommandOrControl+Left',
  moveRight:        'CommandOrControl+Right',
};

// Order + grouping + human labels for the Keybinds settings pane.
const KEYBIND_META = [
  { group: 'General', action: 'toggleVisibility', label: 'Toggle visibility of Veil' },
  { group: 'General', action: 'assist',           label: 'Ask Veil about your screen or audio' },
  { group: 'General', action: 'say',              label: 'Suggest what to say next' },
  { group: 'General', action: 'leetcode',         label: 'Solve the problem on screen' },
  { group: 'General', action: 'clearChat',        label: 'Clear the current conversation' },
  { group: 'General', action: 'session',          label: 'Start or stop a listening session' },
  { group: 'General', action: 'stealth',          label: 'Toggle undetectability (screen-share hiding)' },
  { group: 'General', action: 'quit',             label: 'Quit Veil' },
  { group: 'Window',  action: 'moveUp',           label: 'Move the window up' },
  { group: 'Window',  action: 'moveDown',         label: 'Move the window down' },
  { group: 'Window',  action: 'moveLeft',         label: 'Move the window left' },
  { group: 'Window',  action: 'moveRight',        label: 'Move the window right' },
  { group: 'Scroll',  action: 'scrollUp',         label: 'Scroll the response up' },
  { group: 'Scroll',  action: 'scrollDown',       label: 'Scroll the response down' },
];

// A permissive structural check for an Electron accelerator string. globalShortcut
// still validates for real at register time (and we try/catch there); this is just
// to reject obvious garbage in the UI before persisting it.
const MODIFIERS = new Set([
  'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl',
  'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta',
]);
const KEY_TOKEN = /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Space|Enter|Return|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Escape|Esc|Plus|numadd|numsub|nummult|numdec|[`~!@#$%^&*()\-_=+\[\]{}\\|;:'",.<>/?])$/;

function isValidAccelerator(accel) {
  if (typeof accel !== 'string') return false;
  const trimmed = accel.trim();
  if (!trimmed) return false;
  const parts = trimmed.split('+');
  const key = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    if (!MODIFIERS.has(parts[i])) return false;
  }
  return KEY_TOKEN.test(key);
}

module.exports = { DEFAULT_KEYBINDS, LEGACY_BAD_KEYBINDS, KEYBIND_META, isValidAccelerator };
