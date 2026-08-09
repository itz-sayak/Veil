const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { getActiveModePrompt, DEFAULT_MODES } = require('./src/modes');
const { DEFAULT_KEYBINDS, KEYBIND_META, isValidAccelerator } = require('./src/keybinds');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const contextDocs = require('./src/context-store');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');

let win = null;
// Which global shortcuts Veil actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. This is
// keyed by action name and surfaced to the Keybinds UI so it can flag conflicts.
let heldShortcuts = {};
const MOVE_STEP = 48; // px per "move window" keypress
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const FLUSH_MS = 900;
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// -------- undetectability (cross-platform) --------
// One code path for every platform so the Security toggle and startup behave
// identically. setContentProtection maps to NSWindowSharingNone on macOS and
// SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows 10 2004+; it is a
// harmless no-op elsewhere. The window flags keep Veil out of the taskbar and
// on top across spaces regardless.
function applyStealth(on) {
  if (!win || win.isDestroyed()) return { ok: false };
  const enable = !!on;
  try { if (WIN_SUPPORTS_CONTENT_PROTECTION) win.setContentProtection(enable); } catch (_) {}
  try { win.setSkipTaskbar(enable); } catch (_) {}
  try { win.setAlwaysOnTop(true, 'screen-saver', 1); } catch (_) {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  if (isMac && typeof win.setHiddenInMissionControl === 'function') {
    try { win.setHiddenInMissionControl(enable); } catch (_) {}
  }
  return { ok: true, on: enable, contentProtection: WIN_SUPPORTS_CONTENT_PROTECTION };
}

const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
  it: 'Italian', nl: 'Dutch', hi: 'Hindi', ja: 'Japanese', ko: 'Korean',
  'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', ar: 'Arabic',
  ru: 'Russian', tr: 'Turkish', pl: 'Polish', id: 'Indonesian', vi: 'Vietnamese'
};
function languageDirective(settings) {
  const code = settings && settings.language;
  if (!code || code === 'en') return '';
  const name = LANGUAGE_NAMES[code] || code;
  return `Respond in ${name}. Use ${name} for the entire reply unless the user explicitly asks for another language.`;
}

function toggleWindowVisibility() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function nudgeWindow(dx, dy) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  win.setBounds({ x: Math.round(b.x + dx * MOVE_STEP), y: Math.round(b.y + dy * MOVE_STEP), width: b.width, height: b.height });
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // 900 wide so the full action row (Assist · Say · Follow-ups · Recap ·
  // transcript · clear) fits on one line without wrapping or hiding controls.
  const W = 900, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox ON. It used to be off because it broke this frameless window's
      // -webkit-app-region:drag regions, but dragging no longer uses them — it
      // is handled explicitly via pointer events and window:drag-* IPC, which
      // works identically under the sandbox. The renderer is pure browser code
      // (no require), and preload only touches contextBridge/ipcRenderer, both
      // of which are available to sandboxed preloads.
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Undetectability is applied through a single cross-platform path (applyStealth)
  // so the Security toggle and startup share exactly the same behaviour. An env
  // override (VEIL_NO_PROTECT, or the legacy CUE_NO_PROTECT) forces it off.
  const envDisabled = !!(process.env.VEIL_NO_PROTECT || process.env.CUE_NO_PROTECT);
  const stealthOn = !envDisabled && savedSettings.undetectability !== false;
  applyStealth(stealthOn);
  if (stealthOn && isWindows && !WIN_SUPPORTS_CONTENT_PROTECTION) {
    console.log(`[veil] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  win.setTitle('Veil'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Veil');
    // Warn about missing content protection on old Windows builds
    if (isWindows && stealthOn && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[veil] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      pushTranscript(turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state Veil is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  const keys = settings.apiKeys || {};

  // Check if we have a streaming-capable key
  if (!keys.deepgram && !keys.openai) {
    streamingMode = false;
    return false;
  }

  streamingMode = true;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        // If streaming fails, disconnect cleanly then fall back to batch mode
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (!sttDisabled) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
        }
        streamingMode = false;
        startFlushLoop(); // activate batch fallback
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside Veil's own process
// and use Veil's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    sttDisabled = false; // reset on re-enable
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
    }
    console.log('[veil] capture started, mode:', streaming ? 'streaming' : 'batch');
  } else {
    stopFlushLoop();
    stopStreamingSTT();
    buffers.you = []; buffers.them = [];
    vad.you.reset(); vad.them.reset();
    ringBuffers.you.clear(); ringBuffers.them.clear();
  }
  send('capture:state', { active, streaming: streamingMode });
  return active;
}

// Fire-and-forget: nothing waits on this, and a failure only means the first
// question pays the indexing cost instead.
function warmDocsIndex() {
  contextDocs.warmIndex().catch((e) => {
    recordEvent({
      level: 'error',
      event: 'context_docs_warm_failed',
      msg: e && e.message ? e.message : String(e),
      frame: 'warmIndex'
    });
  });
}

// A corrupt index or an unreadable chunk file must never cost the user an
// answer — degrade to "no document context" and log it.
async function safeDocsContext(args) {
  try {
    return await contextDocs.buildDocsContext(args);
  } catch (e) {
    recordEvent({
      level: 'error',
      event: 'context_docs_failed',
      msg: e && e.message ? e.message : String(e),
      frame: 'buildDocsContext',
      context: { mode: args && args.mode }
    });
    return null;
  }
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try { imageDataUrl = await captureScreenshot(); }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        send('status', { message: 'Screen capture needs permission — grant screen/audio access to Veil in your system settings.' });
      }
    }

    const settingsForPrompt = store.getSettings();
    const contextBlock = buildInterviewContext(settingsForPrompt, mode, transcript);
    let system = def.buildSystem ? def.buildSystem(contextBlock) : (def.system || '');
    // Persona mode: the active mode's system prompt is prepended so it shapes
    // every response (composes with the functional feature's own instructions).
    const modePrompt = getActiveModePrompt(settingsForPrompt);
    if (modePrompt) system = modePrompt + '\n\n' + system;
    // Response language: overrides the default-English rule when the user picked one.
    const langDirective = languageDirective(settingsForPrompt);
    if (langDirective) system = langDirective + '\n\n' + system;
    // Uploaded reference documents: retrieved per request and appended *after*
    // the instructions, so the model reads its directions first and the
    // untrusted file excerpts last.
    const docsBlock = await safeDocsContext({ mode, transcript, userText, settings: settingsForPrompt });
    if (docsBlock) system = system + '\n\n' + docsBlock;
    const built = def.build({ transcript, userText: userText || '' });
    await llm.stream({
      system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (t) => send('llm:token', { text: t })
    });
    send('llm:done', {});
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const mode = typeof payload.mode === 'string' ? payload.mode : '';
  if (!MODES[mode]) return; // only known functional modes
  const text = typeof payload.text === 'string' ? payload.text : '';
  runFeature(mode, text);
});
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });

// -------- manual window dragging --------
// The anchor is held here rather than in the renderer so the first pointermove
// can't beat an async "where is the window?" round-trip and jump the window.
let dragAnchor = null;
ipcMain.on('window:drag-start', (_e, p) => {
  if (!win || win.isDestroyed() || !p) return;
  const [x, y] = win.getPosition();
  dragAnchor = { winX: x, winY: y, sx: p.screenX, sy: p.screenY };
});
ipcMain.on('window:drag-move', (_e, p) => {
  if (!win || win.isDestroyed() || !dragAnchor || !p) return;
  if (typeof p.screenX !== 'number' || typeof p.screenY !== 'number') return;
  win.setPosition(
    Math.round(dragAnchor.winX + (p.screenX - dragAnchor.sx)),
    Math.round(dragAnchor.winY + (p.screenY - dragAnchor.sy))
  );
});
ipcMain.on('window:drag-end', () => {
  dragAnchor = null;
  // 'moved' only fires for OS-driven moves, so persist the position ourselves.
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    store.setSettings({ windowX: x, windowY: y });
  }
});
// Only OS settings deep-links are allowed through openExternal — never arbitrary
// http(s)/file/custom URLs from the renderer (guards against navigation abuse).
const OPEN_PANE_ALLOW = /^(ms-settings:|x-apple\.systempreferences:)/i;
ipcMain.on('open-pane', (_e, url) => {
  if (typeof url !== 'string' || !OPEN_PANE_ALLOW.test(url)) return;
  shell.openExternal(url).catch(() => {});
});
ipcMain.on('log', (_e, msg) => console.log('[renderer]', typeof msg === 'string' ? msg : ''));
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- modes (persona system prompts) --------
function currentModes() {
  const s = store.getSettings();
  const m = (s && s.modes) || {};
  const list = Array.isArray(m.list) && m.list.length ? m.list : DEFAULT_MODES;
  const activeId = typeof m.activeId === 'string' && m.activeId ? m.activeId : 'general';
  return { list, activeId };
}
ipcMain.handle('modes:list', () => currentModes());
ipcMain.handle('modes:set-active', (_e, id) => {
  if (typeof id !== 'string') return { ok: false };
  const { list } = currentModes();
  if (!list.some((m) => m.id === id)) return { ok: false };
  store.setSettings({ modes: { activeId: id } });
  return { ok: true, activeId: id };
});
ipcMain.handle('modes:save', (_e, mode) => {
  if (!mode || typeof mode !== 'object') return { ok: false, error: 'Invalid mode' };
  const name = String(mode.name || '').trim().slice(0, 60);
  const systemPrompt = String(mode.systemPrompt || '').slice(0, 8000);
  if (!name) return { ok: false, error: 'Name is required' };
  const list = currentModes().list.slice();
  let id = typeof mode.id === 'string' && mode.id ? mode.id : null;
  if (id) {
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) list[idx] = { ...list[idx], name, systemPrompt };
    else list.push({ id, name, systemPrompt, builtin: false });
  } else {
    id = 'm' + Date.now().toString(36);
    list.push({ id, name, systemPrompt, builtin: false });
  }
  store.setSettings({ modes: { list } });
  return { ok: true, id, list };
});
ipcMain.handle('modes:delete', (_e, id) => {
  if (typeof id !== 'string') return { ok: false };
  const { list, activeId } = currentModes();
  const target = list.find((m) => m.id === id);
  if (!target) return { ok: false, error: 'Not found' };
  if (target.builtin) return { ok: false, error: 'Built-in modes cannot be deleted' };
  const next = list.filter((m) => m.id !== id);
  const nextActive = activeId === id ? 'general' : activeId;
  store.setSettings({ modes: { list: next, activeId: nextActive } });
  return { ok: true, list: next, activeId: nextActive };
});

// -------- context documents --------
function docsPayload() {
  const s = store.getSettings();
  // Every mutation drops the cached index; start rebuilding it straight away so
  // the next question doesn't have to wait for it.
  warmDocsIndex();
  return {
    docs: contextDocs.listDocs(),
    enabled: (s.contextDocs || {}).enabled !== false,
    semantic: contextDocs.semanticStatus()
  };
}

// Embeds anything not yet covered, in the background. Nothing waits on it: the
// documents are already keyword-searchable, this only widens their reach.
function embedDocsInBackground() {
  contextDocs.embedPending((p) => send('docs:progress', p))
    .then((res) => {
      if (res && res.ok) send('docs:progress', { state: 'embed-done', embedded: res.embedded, failed: res.failed });
      warmDocsIndex();
    })
    .catch((e) => {
      recordEvent({
        level: 'error', event: 'context_docs_embed_failed',
        msg: e && e.message ? e.message : String(e), frame: 'embedPending'
      });
    });
}

// Ingest is slow enough for a big PDF to look like a hang, so each file reports
// as it starts and finishes.
async function ingestOne(file) {
  send('docs:progress', { name: file.name, state: 'working' });
  let res;
  try {
    res = await contextDocs.addDoc(file);
  } catch (e) {
    res = { ok: false, error: (file.name || 'File') + ': ' + (e && e.message ? e.message : String(e)) };
  }
  send('docs:progress', { name: file.name, state: res.ok ? 'done' : 'error', error: res.error || null });
  return res;
}

ipcMain.handle('docs:list', () => docsPayload());

// The file picker runs entirely in main: the renderer names no path, and main
// only ever reads a path the user chose in the OS dialog.
ipcMain.handle('docs:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Add reference documents',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'text', 'pdf'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true, ...docsPayload() };

  const errors = [];
  for (const p of result.filePaths) {
    let buffer;
    try { buffer = fs.readFileSync(p); }
    catch (e) { errors.push(path.basename(p) + ': could not read the file.'); continue; }
    const res = await ingestOne({ name: path.basename(p), buffer });
    if (!res.ok) errors.push(res.error);
  }
  embedDocsInBackground();
  return { ok: !errors.length, errors, ...docsPayload() };
});

// Drag-and-drop path. Electron 32 removed File.path, so the renderer sends the
// bytes it read rather than a filename we would have to trust and resolve.
ipcMain.handle('docs:add', async (_e, files) => {
  const list = Array.isArray(files) ? files : [files];
  const errors = [];
  for (const f of list) {
    if (!f || typeof f.name !== 'string' || !f.buffer) { errors.push('Invalid file.'); continue; }
    const buffer = Buffer.from(f.buffer);
    if (buffer.length > contextDocs.MAX_FILE_BYTES) { errors.push(f.name + ' is too large.'); continue; }
    const res = await ingestOne({ name: f.name, buffer });
    if (!res.ok) errors.push(res.error);
  }
  embedDocsInBackground();
  return { ok: !errors.length, errors, ...docsPayload() };
});

ipcMain.handle('docs:delete', (_e, id) => {
  const res = contextDocs.deleteDoc(typeof id === 'string' ? id : '');
  return { ...res, ...docsPayload() };
});

ipcMain.handle('docs:toggle', (_e, payload) => {
  const id = payload && typeof payload.id === 'string' ? payload.id : '';
  const res = contextDocs.setDocEnabled(id, !!(payload && payload.enabled));
  return { ...res, ...docsPayload() };
});

ipcMain.handle('docs:set-enabled', (_e, on) => {
  store.setSettings({ contextDocs: { enabled: !!on } });
  return { ok: true, ...docsPayload() };
});

// Semantic search on/off. Turning it on kicks off embedding for the existing
// library; turning it off deletes the vectors rather than leaving the user's
// disk holding embeddings for a feature they switched off.
ipcMain.handle('docs:set-semantic', (_e, on) => {
  const enable = !!on;
  store.setSettings({ contextDocs: { semantic: enable } });
  if (enable) embedDocsInBackground();
  else contextDocs.clearVectors();
  return { ok: true, ...docsPayload() };
});

// -------- keybinds --------
ipcMain.handle('keybinds:get', () => ({ binds: effectiveKeybinds(), held: heldShortcuts, meta: KEYBIND_META, defaults: DEFAULT_KEYBINDS }));
ipcMain.handle('keybinds:set', (_e, map) => {
  if (!map || typeof map !== 'object') return { ok: false };
  const clean = {};
  for (const action of Object.keys(DEFAULT_KEYBINDS)) {
    const v = map[action];
    if (v === '' || v === null) { clean[action] = ''; continue; } // allow unbinding
    if (typeof v === 'string' && isValidAccelerator(v)) clean[action] = v;
    else clean[action] = DEFAULT_KEYBINDS[action];
  }
  store.setSettings({ keybinds: clean });
  const held = registerShortcuts();
  return { ok: true, held, binds: effectiveKeybinds() };
});
ipcMain.handle('keybinds:reset', () => {
  store.setSettings({ keybinds: { ...DEFAULT_KEYBINDS } });
  const held = registerShortcuts();
  return { ok: true, held, binds: effectiveKeybinds() };
});
ipcMain.handle('keybinds:validate', (_e, accel) => ({ valid: isValidAccelerator(accel) }));

// -------- undetectability + security --------
ipcMain.handle('stealth:get', () => ({
  on: store.getSettings().undetectability !== false,
  contentProtection: WIN_SUPPORTS_CONTENT_PROTECTION,
  platform: process.platform
}));
ipcMain.handle('stealth:set', (_e, on) => {
  store.setSettings({ undetectability: !!on });
  return applyStealth(!!on);
});
ipcMain.handle('security:info', () => ({
  encryptionAvailable: store.encryptionAvailable(),
  contentProtection: WIN_SUPPORTS_CONTENT_PROTECTION,
  platform: process.platform
}));

// -------- shortcuts --------
// Every bindable action maps to a handler here. The Keybinds UI can rebind any of
// these; registerShortcuts() re-reads the accelerators from settings and re-binds.
function shortcutHandlers() {
  return {
    toggleVisibility: () => toggleWindowVisibility(),
    assist: () => runFeature('assist', ''),
    say: () => runFeature('say', ''),
    leetcode: () => runFeature('leetcode', ''),
    clearChat: () => { transcript.splice(0, transcript.length); send('ui:clear', {}); },
    session: () => send('ui:toggle-capture', {}),
    stealth: () => send('ui:toggle-stealth', {}),
    quit: () => app.quit(),
    moveUp: () => nudgeWindow(0, -1),
    moveDown: () => nudgeWindow(0, 1),
    moveLeft: () => nudgeWindow(-1, 0),
    moveRight: () => nudgeWindow(1, 0),
    scrollUp: () => send('ui:scroll', { dir: -1 }),
    scrollDown: () => send('ui:scroll', { dir: 1 }),
  };
}

function effectiveKeybinds() {
  const saved = (store.getSettings() || {}).keybinds || {};
  return { ...DEFAULT_KEYBINDS, ...saved };
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  heldShortcuts = {};
  const binds = effectiveKeybinds();
  const handlers = shortcutHandlers();
  for (const [action, accel] of Object.entries(binds)) {
    if (!handlers[action] || !accel) continue;
    let ok = false;
    if (isValidAccelerator(accel)) {
      try { ok = globalShortcut.register(accel, handlers[action]); } catch (_) { ok = false; }
    }
    heldShortcuts[action] = ok;
    if (!ok) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'could not register ' + action + ' (' + accel + ')', frame: 'registerShortcuts', context: { action, accel } });
    }
  }
  return heldShortcuts;
}

// -------- lifecycle --------
app.whenReady().then(() => {
  app.setName('Veil');
  if (isWindows) {
    process.title = 'Veil';
  }

  if (isMac && app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using Veil's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      const request = { video: sources[0] };
      if (isWindows) request.audio = true;
      else request.audio = 'loopback';
      callback(request);
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...heldShortcuts },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();

  // Index the document library now, in the background, rather than on the first
  // question. A large library takes seconds to index; doing that lazily would
  // put the whole delay in front of the first answer of a live call.
  warmDocsIndex();
  // Catch up on anything added or re-uploaded while semantic search was off, or
  // left unfinished by a previous run.
  embedDocsInBackground();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
});
app.on('window-all-closed', () => app.quit());
