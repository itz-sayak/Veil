const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

// Channels the main process may push to the renderer. Anything not listed here
// is rejected by on() so a compromised/injected renderer cannot subscribe to
// arbitrary IPC traffic.
const ALLOWED_EVENTS = [
  'capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error',
  'status', 'transcript', 'stt:interim', 'stt:final', 'stt:status', 'vad:state',
  'applink:consent-request',
  // Per-file progress while a document is being ingested
  'docs:progress',
  // UI actions driven by global shortcuts
  'ui:scroll', 'ui:clear', 'ui:toggle-capture', 'ui:toggle-stealth'
];

const api = {
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  securityInfo: () => ipcRenderer.invoke('security:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[veil] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),

  // Manual window dragging (see the note in styles.css)
  dragStart: (screenX, screenY) => ipcRenderer.send('window:drag-start', { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.send('window:drag-move', { screenX, screenY }),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),

  // Modes (persona system prompts)
  modesList: () => ipcRenderer.invoke('modes:list'),
  modesSetActive: (id) => ipcRenderer.invoke('modes:set-active', id),
  modesSave: (mode) => ipcRenderer.invoke('modes:save', mode),
  modesDelete: (id) => ipcRenderer.invoke('modes:delete', id),

  // Context documents (uploaded reference files)
  docsList: () => ipcRenderer.invoke('docs:list'),
  docsPick: () => ipcRenderer.invoke('docs:pick'),
  docsAdd: (files) => ipcRenderer.invoke('docs:add', files),
  docsDelete: (id) => ipcRenderer.invoke('docs:delete', id),
  docsToggle: (id, enabled) => ipcRenderer.invoke('docs:toggle', { id, enabled }),
  docsSetEnabled: (on) => ipcRenderer.invoke('docs:set-enabled', on),
  docsSetSemantic: (on) => ipcRenderer.invoke('docs:set-semantic', on),

  // Keybinds
  keybindsGet: () => ipcRenderer.invoke('keybinds:get'),
  keybindsSet: (map) => ipcRenderer.invoke('keybinds:set', map),
  keybindsReset: () => ipcRenderer.invoke('keybinds:reset'),
  keybindsValidate: (accel) => ipcRenderer.invoke('keybinds:validate', accel),

  // Undetectability
  stealthGet: () => ipcRenderer.invoke('stealth:get'),
  stealthSet: (on) => ipcRenderer.invoke('stealth:set', on),

  // App Link
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),

  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    if (!ALLOWED_EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
};

contextBridge.exposeInMainWorld('veil', api);
