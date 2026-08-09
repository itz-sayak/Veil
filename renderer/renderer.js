/* Veil renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const veil = window.veil; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = veil.platform === 'win32';
  const isMac = veil.platform === 'darwin';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('mic', { size: 16 });
  function setListenIcon(active) { $('#stop-btn').innerHTML = active ? icon('stop-square', { size: 15 }) : icon('mic', { size: 16 }); }
  function setStealthButton(on) {
    const btn = document.getElementById('stealth-btn');
    if (!btn) return;
    btn.innerHTML = icon(on ? 'shield' : 'shield-off', { size: 15 });
    btn.classList.toggle('off', !on);
    btn.title = on
      ? 'Undetectability: on — hidden from screen shares. Click to turn off.'
      : 'Undetectability: off — visible in screen shares. Click to turn on.';
  }
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  const transcriptIC = document.querySelector('#transcript-toggle-btn .ic');
  if (transcriptIC) transcriptIC.innerHTML = icon('file-text', { size: 15 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });
  // Mode switcher + settings sidebar icons
  const modeChev = document.querySelector('#mode-btn .mode-chev');
  if (modeChev) modeChev.innerHTML = icon('chevron-down', { size: 12 });
  const sLogo = document.getElementById('s-logo');
  if (sLogo) sLogo.innerHTML = icon('logo', { size: 20 });
  document.querySelectorAll('.s-nav-ic[data-ic]').forEach((el) => {
    el.innerHTML = icon(el.dataset.ic, { size: 16 });
  });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  // ---- transcript helpers ------------------------------------------------
  let transcriptOpen = false;
  let transcriptInterimEl = null;

  function appendTranscriptTurn(channel, text, isInterim) {
    const list = document.getElementById('transcript-list');
    if (!list) return;
    const ph = list.querySelector('.transcript-placeholder');
    if (ph) ph.remove();
    if (isInterim) {
      if (!transcriptInterimEl) {
        transcriptInterimEl = document.createElement('div');
        transcriptInterimEl.className = 'tc-turn tc-interim';
        list.appendChild(transcriptInterimEl);
      }
      transcriptInterimEl.textContent = (channel === 'them' ? 'Them: ' : 'You: ') + text;
    } else {
      const div = document.createElement('div');
      div.className = 'tc-turn tc-' + channel;
      div.textContent = (channel === 'them' ? 'Them: ' : 'You: ') + text;
      list.appendChild(div);
    }
    if (transcriptOpen) {
      const wrap = document.getElementById('transcript-wrap');
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function updateTranscriptInterim(channel, text) {
    appendTranscriptTurn(channel, text, true);
  }

  function clearTranscriptInterim() {
    if (transcriptInterimEl) {
      transcriptInterimEl.remove();
      transcriptInterimEl = null;
    }
  }

  // ---- toast helper ------------------------------------------------------
  let toastTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('app').appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    veil.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMode('assist', ''); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await veil.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  $('#hide-btn').addEventListener('click', () => {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  });

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      await startSystemAudio();
    }
    await veil.captureToggle();
  });

  // Transcript toggle
  const transcriptToggleBtn = document.getElementById('transcript-toggle-btn');
  if (transcriptToggleBtn) {
    transcriptToggleBtn.addEventListener('click', () => {
      transcriptOpen = !transcriptOpen;
      const wrap = document.getElementById('transcript-wrap');
      if (wrap) {
        wrap.classList.toggle('hidden', !transcriptOpen);
        if (transcriptOpen) {
          const list = document.getElementById('transcript-list');
          if (list && !list.children.length) {
            const ph = document.createElement('div');
            ph.className = 'transcript-placeholder';
            ph.textContent = 'Nothing heard yet — start listening to begin.';
            list.appendChild(ph);
          }
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        }
      }
    });
  }

  // Clear transcript
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      await veil.clearTranscript();
      clearMessages();
      // Also clear the floating interim bar
      if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
      const list = document.getElementById('transcript-list');
      if (list) list.innerHTML = '';
      transcriptInterimEl = null;
      showToast('Transcript cleared', 3000);
    });
  }

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  async function startMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      veil.log('mic stream started');
      audioCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'veil-audio-processor');
        micWorklet.port.onmessage = (e) => {
          veil.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        veil.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        veil.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          veil.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      veil.log('mic error: ' + message);
      showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
    }
  }
  function stopMic() {
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in Veil's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null;
  async function startSystemAudio() {
    if (sysStream) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      veil.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        veil.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        const msg = isWindows
          ? 'No system-audio loopback track detected. On Windows, make sure your default audio device is not set to exclusive mode. Go to Sound Settings → your playback device → Properties → Advanced → uncheck "Allow applications to take exclusive control".'
          : 'No system-audio loopback track was detected.';
        showStatus(msg);
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'veil-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          veil.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        veil.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        veil.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          veil.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      veil.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to Veil and try again.');
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
    const labels = {
      off:          'Not listening',
      idle:         'Listening — silence detected',
      speaking:     'Speech detected',
      transcribing: 'Transcribing…'
    };
    dot.title = labels[dotState] || '';
  }

  let sttState = 'disconnected';

  function updateSttStatus({ active, streaming } = {}) {
    const label = document.getElementById('stt-status');
    if (!label) return;
    if (active === false) {
      sttState = 'disconnected';
      label.textContent = 'off';
    } else if (active === true) {
      sttState = streaming ? 'connecting' : 'batch';
      label.textContent = sttState;
    }
    label.className = 'stt-status stt-' + sttState;
  }

  // ---- events from main --------------------------------------------------
  veil.on('capture:state', ({ active, streaming }) => {
    setLiveDotState(active ? 'idle' : 'off');
    $('#stop-btn').classList.toggle('active', active);
    setListenIcon(active);
    // startSystemAudio() is called directly from the stop-button click handler
    // so that the getDisplayMedia request has a fresh user gesture.
    // Here we only start the mic (no gesture required) and stop everything on deactivate.
    if (active) { startMic(); } else { stopMic(); stopSystemAudio(); }
    updateSttStatus({ active, streaming });
  });

  // ---- real-time transcript display (interim + final) ----
  let interimEl = null;
  function getOrCreateInterimEl() {
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'interim-transcript';
      const panel = document.getElementById('panel');
      const actionRow = document.getElementById('action-row');
      panel.insertBefore(interimEl, actionRow);
    }
    return interimEl;
  }
  veil.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    const el = getOrCreateInterimEl();
    const label = channel === 'them' ? 'Them' : 'You';
    el.textContent = `${label}: ${text}`;
    el.classList.add('show');
    updateTranscriptInterim(channel, text);
  });
  veil.on('stt:final', ({ channel, text }) => {
    setLiveDotState('idle');
    // Clear interim when we get a final
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    clearTranscriptInterim();
  });
  veil.on('stt:status', ({ channel, status }) => {
    veil.log(`[stt] ${channel} ${status}`);
    if (status === 'connected') {
      sttState = 'streaming';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = sttState; label.className = 'stt-status stt-streaming'; }
    }
  });
  veil.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  veil.on('llm:start', ({ userBubble, small, category }) => {
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
    group.className = 'response-group';
    const sep = document.createElement('div');
    sep.className = 'response-sep';
    sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    group.appendChild(sep);
    if (userBubble) {
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      group.appendChild(b);
    }
    if (category) {
      const pill = document.createElement('div');
      pill.className = 'category-pill';
      pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      group.appendChild(pill);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    messages.appendChild(group);
    sep.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setBusy(true);
  });
  veil.on('llm:token', ({ text }) => appendToken(text));
  veil.on('llm:done', () => { finalizeAi(); setBusy(false); });
  veil.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  veil.on('transcript', ({ channel, text }) => {
    appendTranscriptTurn(channel, text, false);
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('veil-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'veil-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  veil.on('status', ({ message }) => {
    veil.log('[status] ' + message);
    showStatus(message);
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) {
        sttState = 'error';
        const label = document.getElementById('stt-status');
        if (label) { label.textContent = sttState; label.className = 'stt-status stt-error'; }
      }
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------
  function updatePrepStatus() {
    if (!settings) return;
    const fields = {
      resume:  !!(settings.resumeText && settings.resumeText.trim()),
      jd:      !!(settings.jobDescription && settings.jobDescription.trim()),
      stories: !!(settings.starStories && settings.starStories.trim()),
      salary:  !!(settings.salaryTarget && settings.salaryTarget.trim())
    };
    document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
      const loaded = fields[el.dataset.field];
      el.classList.toggle('loaded', loaded);
      el.classList.toggle('missing', !loaded);
      el.title = loaded
        ? el.textContent.trim() + ' loaded'
        : el.textContent.trim() + ' not set — add in Settings';
    });
  }

  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = m.fast || 'fast model';
    const smart = m.smart || 'smart model';
    const btn = document.getElementById('smart-toggle');
    if (btn) btn.title = 'Fast: ' + fast + ' · Smart: ' + smart + ' (higher quality, ~2× slower)';
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() { fillSettings(); scrim.classList.remove('hidden'); }
  function closeSettings() { saveSettings(); scrim.classList.add('hidden'); }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  // Sidebar navigation
  function switchSection(name) {
    document.querySelectorAll('.s-nav-item').forEach(t => t.classList.toggle('on', t.dataset.section === name));
    document.querySelectorAll('.s-section').forEach(p => p.classList.toggle('hidden', p.dataset.section !== name));
    const content = document.querySelector('.s-content');
    if (content) content.scrollTop = 0;
  }
  document.querySelectorAll('.s-nav-item').forEach((navBtn) => {
    navBtn.addEventListener('click', () => {
      if (!navBtn.classList.contains('on')) {
        saveSettings().catch((err) => console.error('[veil] section auto-save error', err));
      }
      switchSection(navBtn.dataset.section);
    });
  });

  function fillSettings() {
    // Keys tab
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    // Profile tab
    $('#resume-text').value = settings.resumeText || '';
    $('#job-description').value = settings.jobDescription || '';
    // Interview Prep tab
    $('#star-stories').value = settings.starStories || '';
    $('#why-company').value = settings.whyCompany || '';
    $('#why-leaving').value = settings.whyLeaving || '';
    $('#work-style').value = settings.workStyle || '';
    // Q&A tab
    $('#salary-target').value = settings.salaryTarget || '';
    $('#questions-to-ask').value = settings.questionsToAsk || '';
    // Language
    const langSel = $('#language-select');
    if (langSel) langSel.value = settings.language || 'en';
    // Sub-UIs (async — fire and forget)
    fillModes();
    fillKeybinds();
    fillSecurity();
    fillDocs();
  }

  // Whoever Veil has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !veil.appLinkState) return;
    let state;
    try { state = await veil.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      label.title = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await veil.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  function statusText() {
    const k = settings.apiKeys;
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.deepgram && 'Deepgram'].filter(Boolean);
    const stt = k.deepgram ? 'Deepgram (streaming)' : (k.openai ? 'OpenAI Realtime' : (k.gemini ? 'Gemini (batch)' : 'none'));
    const ready = [
      settings.resumeText ? '✓ resume' : null,
      settings.jobDescription ? '✓ JD' : null,
      settings.starStories ? '✓ stories' : null,
      settings.salaryTarget ? '✓ salary' : null
    ].filter(Boolean);
    return `${settings.provider} · STT: ${stt}` + (ready.length ? ' · ' + ready.join(' · ') : '');
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    updateSmartTooltip();
  }));

  async function saveSettings() {
    // Keys
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // Profile
    settings.resumeText = $('#resume-text').value.trim();
    settings.jobDescription = $('#job-description').value.trim();
    // Interview Prep
    settings.starStories = $('#star-stories').value.trim();
    settings.whyCompany = $('#why-company').value.trim();
    settings.whyLeaving = $('#why-leaving').value.trim();
    settings.workStyle = $('#work-style').value.trim();
    // Q&A
    settings.salaryTarget = $('#salary-target').value.trim();
    settings.questionsToAsk = $('#questions-to-ask').value.trim();
    // Language
    const langSel = $('#language-select');
    if (langSel) settings.language = langSel.value;
    await veil.settingsSet(settings);
    updatePrepStatus();
    updateSmartTooltip();
  }

  // ---- modes / keybinds / security / language ----------------------------
  let modesState = { list: [], activeId: 'general' };
  let editingModeId = null;
  let keybindMeta = [];
  let keybindMap = {};
  let keybindHeld = {};

  function displayAccel(accel) {
    if (!accel) return 'Unbound';
    return accel
      .replaceAll('CommandOrControl', isMac ? '⌘' : 'Ctrl')
      .replaceAll('CmdOrCtrl', isMac ? '⌘' : 'Ctrl')
      .replaceAll('Command', '⌘')
      .replaceAll('Control', 'Ctrl')
      .replaceAll('Shift', '⇧')
      .replaceAll('Alt', isMac ? '⌥' : 'Alt')
      .replaceAll('Option', '⌥')
      .replaceAll('Return', '↵').replaceAll('Enter', '↵')
      .replaceAll('Up', '↑').replaceAll('Down', '↓').replaceAll('Left', '←').replaceAll('Right', '→')
      .split('+').join(' ');
  }

  function eventToAccelerator(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.key;
    const map = { ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'Enter': 'Return', 'Backspace': 'Backspace', 'Delete': 'Delete', 'Tab': 'Tab', 'Escape': '__ESC__' };
    if (map[key]) key = map[key];
    else if (key.length === 1) key = key.toUpperCase();
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) { /* function keys ok */ }
    else return null; // a lone modifier or unsupported key — keep waiting
    if (key === '__ESC__') return null;
    parts.push(key);
    return parts.join('+');
  }

  // Modes ------------------------------------------------------------------
  function updateModeButton() {
    const lbl = document.getElementById('mode-btn-label');
    const active = modesState.list.find(m => m.id === modesState.activeId);
    if (lbl) lbl.textContent = active ? active.name : 'Mode';
  }

  async function fillModes() {
    try { modesState = await veil.modesList(); } catch (_) { return; }
    const active = modesState.list.find(m => m.id === modesState.activeId) || modesState.list[0];
    selectModeForEdit(active ? active.id : null);
    updateModeButton();
  }

  function renderModesList() {
    const host = document.getElementById('modes-list');
    if (!host) return;
    host.innerHTML = '';
    modesState.list.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'mode-row' + (m.id === editingModeId ? ' editing' : '') + (m.id === modesState.activeId ? ' active' : '');
      const name = document.createElement('button');
      name.className = 'mode-row-name';
      name.innerHTML = esc(m.name) + (m.builtin ? ' <span class="mode-badge">built-in</span>' : '');
      name.addEventListener('click', () => selectModeForEdit(m.id));
      const use = document.createElement('button');
      use.className = 'mode-row-use' + (m.id === modesState.activeId ? ' on' : '');
      use.textContent = m.id === modesState.activeId ? 'Active' : 'Use';
      use.disabled = m.id === modesState.activeId;
      use.addEventListener('click', async () => {
        await veil.modesSetActive(m.id);
        modesState.activeId = m.id;
        renderModesList(); updateModeButton(); rebuildModeMenu();
      });
      row.append(name, use);
      host.appendChild(row);
    });
  }

  function selectModeForEdit(id) {
    editingModeId = id;
    const m = modesState.list.find(x => x.id === id);
    const nameEl = document.getElementById('mode-name');
    const promptEl = document.getElementById('mode-prompt');
    if (nameEl) nameEl.value = m ? m.name : '';
    if (promptEl) promptEl.value = m ? (m.systemPrompt || '') : '';
    const del = document.getElementById('mode-delete');
    if (del) { del.disabled = !m || m.builtin; del.style.display = (m && m.builtin) ? 'none' : ''; }
    const st = document.getElementById('mode-status'); if (st) st.textContent = '';
    renderModesList();
  }

  function bindModeEditor() {
    const newBtn = document.getElementById('mode-new');
    const saveBtn = document.getElementById('mode-save');
    const delBtn = document.getElementById('mode-delete');
    if (newBtn) newBtn.addEventListener('click', () => {
      editingModeId = null;
      document.getElementById('mode-name').value = '';
      document.getElementById('mode-prompt').value = '';
      const del = document.getElementById('mode-delete'); if (del) { del.disabled = true; del.style.display = 'none'; }
      document.getElementById('mode-status').textContent = 'New mode — name it and write a system prompt, then Save.';
      renderModesList();
    });
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const name = document.getElementById('mode-name').value.trim();
      const systemPrompt = document.getElementById('mode-prompt').value;
      const st = document.getElementById('mode-status');
      if (!name) { st.textContent = 'Name is required.'; return; }
      const res = await veil.modesSave({ id: editingModeId, name, systemPrompt });
      if (!res || !res.ok) { st.textContent = (res && res.error) || 'Could not save.'; return; }
      editingModeId = res.id;
      modesState.list = res.list;
      st.textContent = 'Saved.';
      renderModesList(); updateModeButton(); rebuildModeMenu();
    });
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!editingModeId) return;
      const res = await veil.modesDelete(editingModeId);
      const st = document.getElementById('mode-status');
      if (!res || !res.ok) { st.textContent = (res && res.error) || 'Could not delete.'; return; }
      modesState.list = res.list; modesState.activeId = res.activeId;
      selectModeForEdit(modesState.list[0] ? modesState.list[0].id : null);
      updateModeButton(); rebuildModeMenu();
      st.textContent = 'Deleted.';
    });
  }

  // Mode switcher popover (header) -----------------------------------------
  const modeBtn = document.getElementById('mode-btn');
  const modeMenu = document.getElementById('mode-menu');
  function rebuildModeMenu() {
    const list = document.getElementById('mode-menu-list');
    if (!list) return;
    list.innerHTML = '';
    modesState.list.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'mode-menu-item' + (m.id === modesState.activeId ? ' on' : '');
      b.textContent = m.name;
      b.addEventListener('click', async () => {
        await veil.modesSetActive(m.id);
        modesState.activeId = m.id;
        updateModeButton(); rebuildModeMenu(); renderModesList();
        closeModeMenu();
      });
      list.appendChild(b);
    });
  }
  function openModeMenu() { rebuildModeMenu(); if (modeMenu) modeMenu.classList.remove('hidden'); }
  function closeModeMenu() { if (modeMenu) modeMenu.classList.add('hidden'); }
  if (modeBtn) modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modeMenu && modeMenu.classList.contains('hidden')) openModeMenu(); else closeModeMenu();
  });
  const modeManageBtn = document.getElementById('mode-menu-manage');
  if (modeManageBtn) modeManageBtn.addEventListener('click', () => { closeModeMenu(); openSettings(); switchSection('modes'); });
  document.addEventListener('click', (e) => {
    if (modeMenu && !modeMenu.classList.contains('hidden') && !e.target.closest('#mode-menu, #mode-btn')) closeModeMenu();
  });

  // Keybinds ---------------------------------------------------------------
  async function fillKeybinds() {
    try {
      const res = await veil.keybindsGet();
      keybindMeta = res.meta || [];
      keybindMap = res.binds || {};
      keybindHeld = res.held || {};
    } catch (_) { return; }
    renderKeybinds();
  }

  function renderKeybinds() {
    const host = document.getElementById('keybinds-list');
    if (!host) return;
    host.innerHTML = '';
    const groups = {};
    keybindMeta.forEach((k) => { (groups[k.group] = groups[k.group] || []).push(k); });
    Object.keys(groups).forEach((group) => {
      const gh = document.createElement('div');
      gh.className = 'kb-group';
      gh.textContent = group;
      host.appendChild(gh);
      groups[group].forEach((k) => {
        const row = document.createElement('div');
        row.className = 'kb-row';
        const label = document.createElement('span');
        label.className = 'kb-label';
        label.textContent = k.label;
        if (keybindHeld[k.action] === false && keybindMap[k.action]) {
          const warn = document.createElement('span');
          warn.className = 'kb-warn';
          warn.textContent = ' (in use by another app)';
          label.appendChild(warn);
        }
        const btn = document.createElement('button');
        btn.className = 'kb-key';
        btn.dataset.action = k.action;
        btn.textContent = displayAccel(keybindMap[k.action]);
        btn.addEventListener('click', () => beginCapture(k.action, btn));
        row.append(label, btn);
        host.appendChild(row);
      });
    });
  }

  function beginCapture(action, btn) {
    document.querySelectorAll('.kb-key.capturing').forEach((b) => { b.classList.remove('capturing'); });
    btn.classList.add('capturing');
    btn.textContent = 'Press keys…';
    const handler = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { cleanup(); renderKeybinds(); return; }
      const accel = eventToAccelerator(e);
      if (!accel) return; // wait for a complete combo
      cleanup();
      keybindMap[action] = accel;
      const res = await veil.keybindsSet(keybindMap);
      if (res && res.binds) keybindMap = res.binds;
      if (res && res.held) keybindHeld = res.held;
      renderKeybinds();
      refreshShortcutHints();
      const st = document.getElementById('keybinds-status');
      if (st) st.textContent = (res && res.held && res.held[action] === false) ? 'Saved, but that combo is already held by another app.' : 'Saved.';
    };
    function cleanup() { document.removeEventListener('keydown', handler, true); }
    document.addEventListener('keydown', handler, true);
  }

  const kbReset = document.getElementById('keybinds-reset');
  if (kbReset) kbReset.addEventListener('click', async () => {
    const res = await veil.keybindsReset();
    if (res && res.binds) keybindMap = res.binds;
    if (res && res.held) keybindHeld = res.held;
    renderKeybinds();
    refreshShortcutHints();
    const st = document.getElementById('keybinds-status'); if (st) st.textContent = 'Reset to defaults.';
  });

  function refreshShortcutHints() {
    const sayHint = document.getElementById('say-shortcut-hint');
    const assistHint = document.getElementById('assist-shortcut-hint');
    if (sayHint && keybindMap.say) sayHint.textContent = displayAccel(keybindMap.say);
    if (assistHint && keybindMap.assist) assistHint.textContent = displayAccel(keybindMap.assist);
  }

  // Security / undetectability ---------------------------------------------
  // Two controls share one piece of state: the Settings → Security switch, and
  // the quick-access shield button in the toolbar. setStealthState() keeps both
  // in sync no matter which one triggered the change.
  function setSwitch(el, on) { if (!el) return; el.classList.toggle('on', !!on); el.setAttribute('aria-checked', on ? 'true' : 'false'); }
  function setStealthState(on) {
    setSwitch(document.getElementById('stealth-toggle'), on);
    setStealthButton(on);
  }
  async function fillSecurity() {
    try {
      const st = await veil.stealthGet();
      setStealthState(st.on);
      const sec = await veil.securityInfo();
      const info = document.getElementById('sec-info');
      if (info) {
        info.textContent =
          'Screen-capture exclusion: ' + (st.contentProtection ? 'supported on this OS' : 'not supported on this OS/build') +
          '  ·  API key encryption: ' + (sec.encryptionAvailable ? 'active (OS keychain)' : 'unavailable — keys are obfuscated only');
      }
    } catch (_) { /* ignore */ }
  }
  async function toggleStealth() {
    const currentlyOn = document.getElementById('stealth-btn') &&
      !document.getElementById('stealth-btn').classList.contains('off');
    const next = !currentlyOn;
    setStealthState(next); // optimistic — feels instant
    const res = await veil.stealthSet(next);
    if (res && typeof res.on === 'boolean') setStealthState(res.on);
    showToast(next ? 'Undetectability on — hidden from screen shares' : 'Undetectability off — visible in screen shares', 3000);
  }
  const stealthToggle = document.getElementById('stealth-toggle');
  if (stealthToggle) stealthToggle.addEventListener('click', toggleStealth);
  const stealthBtn = document.getElementById('stealth-btn');
  if (stealthBtn) stealthBtn.addEventListener('click', toggleStealth);
  veil.on('ui:toggle-stealth', toggleStealth);

  // Context documents ------------------------------------------------------
  let docsState = { docs: [], enabled: true, semantic: {} };

  function formatBytes(n) {
    if (!n) return '0 KB';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function applyDocsState(res) {
    if (!res) return;
    if (Array.isArray(res.docs)) docsState.docs = res.docs;
    if (typeof res.enabled === 'boolean') docsState.enabled = res.enabled;
    if (res.semantic) docsState.semantic = res.semantic;
    renderDocs();
  }

  function setDocsStatus(text) {
    const st = document.getElementById('docs-status');
    if (st) st.textContent = text || '';
  }

  async function fillDocs() {
    try { applyDocsState(await veil.docsList()); }
    catch (_) { /* leave the list as-is */ }
  }

  function renderSemantic() {
    const s = docsState.semantic || {};
    setSwitch(document.getElementById('docs-semantic-toggle'), s.on && s.available);

    const badge = document.getElementById('docs-semantic-badge');
    if (badge) badge.textContent = s.available ? (s.provider === 'gemini' ? '· Gemini' : '· OpenAI') : '· needs an OpenAI or Gemini key';

    const status = document.getElementById('docs-semantic-status');
    if (!status) return;
    if (!s.available) {
      status.textContent = 'Add an OpenAI or Gemini API key in General to enable this. Anthropic keys cannot produce embeddings.';
    } else if (!s.on) {
      status.textContent = 'Off — questions are matched on keywords only.';
    } else if (s.working) {
      status.textContent = 'Embedding documents…';
    } else if (s.total && s.embedded < s.total) {
      status.textContent = `${s.embedded} of ${s.total} documents embedded. The rest are still searchable by keyword.`;
    } else if (s.total) {
      status.textContent = `All ${s.total} document${s.total === 1 ? '' : 's'} embedded (${s.model}).`;
    } else {
      status.textContent = 'On — documents will be embedded as you add them.';
    }
  }

  function renderDocs() {
    setSwitch(document.getElementById('docs-toggle'), docsState.enabled);
    renderSemantic();

    const host = document.getElementById('docs-list');
    if (!host) return;
    host.innerHTML = '';

    if (!docsState.docs.length) {
      const empty = document.createElement('div');
      empty.className = 'docs-empty';
      empty.textContent = 'No documents yet. Add a file and Veil will quote from it when it is relevant.';
      host.appendChild(empty);
      return;
    }

    docsState.docs.forEach((d) => {
      const on = d.enabled !== false;
      const row = document.createElement('div');
      row.className = 'docs-row' + (on ? '' : ' off');

      const info = document.createElement('div');
      info.className = 'docs-info';
      const name = document.createElement('div');
      name.className = 'docs-name';
      name.textContent = d.name;
      name.title = d.name;
      const meta = document.createElement('div');
      meta.className = 'docs-meta';
      meta.textContent = d.ext.replace('.', '').toUpperCase() + ' · ' +
        d.chunkCount + ' passage' + (d.chunkCount === 1 ? '' : 's') + ' · ' + formatBytes(d.bytes);
      info.append(name, meta);

      const use = document.createElement('button');
      use.className = 'docs-use' + (on ? ' on' : '');
      use.textContent = on ? 'In use' : 'Off';
      use.title = on ? 'Stop using this document' : 'Use this document';
      use.addEventListener('click', async () => {
        applyDocsState(await veil.docsToggle(d.id, !on));
        setDocsStatus('');
      });

      const del = document.createElement('button');
      del.className = 'docs-del';
      del.textContent = '×';
      del.title = 'Remove ' + d.name;
      del.setAttribute('aria-label', 'Remove ' + d.name);
      del.addEventListener('click', async () => {
        const res = await veil.docsDelete(d.id);
        applyDocsState(res);
        setDocsStatus(res && res.ok ? 'Removed ' + d.name + '.' : 'Could not remove that document.');
      });

      row.append(info, use, del);
      host.appendChild(row);
    });
  }

  function reportDocsResult(res) {
    applyDocsState(res);
    if (res && res.canceled) { setDocsStatus(''); return; }
    const errors = (res && res.errors) || [];
    setDocsStatus(errors.length ? errors.join(' ') : 'Ready.');
  }

  const docsToggleEl = document.getElementById('docs-toggle');
  if (docsToggleEl) docsToggleEl.addEventListener('click', async () => {
    const next = !docsState.enabled;
    docsState.enabled = next;         // optimistic, matching the stealth switch
    renderDocs();
    applyDocsState(await veil.docsSetEnabled(next));
  });

  const docsSemanticEl = document.getElementById('docs-semantic-toggle');
  if (docsSemanticEl) docsSemanticEl.addEventListener('click', async () => {
    const s = docsState.semantic || {};
    if (!s.available) {
      setDocsStatus('Add an OpenAI or Gemini key in Settings → General first.');
      return;
    }
    applyDocsState(await veil.docsSetSemantic(!s.on));
  });

  const docsPickBtn = document.getElementById('docs-pick');
  if (docsPickBtn) docsPickBtn.addEventListener('click', async () => {
    setDocsStatus('Reading…');
    try { reportDocsResult(await veil.docsPick()); }
    catch (e) { setDocsStatus('Could not add those files.'); }
  });

  // Drag-and-drop. Electron 32 removed File.path, so the bytes are read here and
  // handed to main — the renderer never names a filesystem path.
  const docsDrop = document.getElementById('docs-drop');
  if (docsDrop) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    docsDrop.addEventListener('dragenter', (e) => { stop(e); docsDrop.classList.add('over'); });
    docsDrop.addEventListener('dragover', (e) => { stop(e); docsDrop.classList.add('over'); });
    docsDrop.addEventListener('dragleave', (e) => { stop(e); docsDrop.classList.remove('over'); });
    docsDrop.addEventListener('drop', async (e) => {
      stop(e);
      docsDrop.classList.remove('over');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      setDocsStatus('Reading…');
      try {
        const payload = [];
        for (const f of files) payload.push({ name: f.name, buffer: await f.arrayBuffer() });
        reportDocsResult(await veil.docsAdd(payload));
      } catch (_) {
        setDocsStatus('Could not read those files.');
      }
    });
  }
  // A file dropped anywhere else would otherwise make Chromium navigate the
  // window to it, replacing the whole UI.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  veil.on('docs:progress', (d) => {
    if (!d) return;
    if (d.state === 'working') setDocsStatus('Reading ' + d.name + '…');
    else if (d.state === 'error') setDocsStatus(d.error || ('Could not read ' + d.name + '.'));
    else if (d.state === 'embedding') setDocsStatus('Embedding ' + d.name + '…');
    else if (d.state === 'embed-error') setDocsStatus('Could not embed ' + d.name + ': ' + (d.error || 'unknown error'));
    else if (d.state === 'embed-done') { setDocsStatus(''); fillDocs(); }
  });

  // Language ---------------------------------------------------------------
  const languageSelect = document.getElementById('language-select');
  if (languageSelect) languageSelect.addEventListener('change', async () => {
    if (settings) settings.language = languageSelect.value;
    await veil.settingsSet({ language: languageSelect.value });
  });

  bindModeEditor();

  // ---- shortcut-driven UI actions from main ------------------------------
  veil.on('ui:scroll', ({ dir }) => {
    const m = document.getElementById('messages');
    if (m) m.scrollBy({ top: (dir || 1) * 140, behavior: 'smooth' });
  });
  veil.on('ui:clear', () => {
    clearMessages();
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    const list = document.getElementById('transcript-list'); if (list) list.innerHTML = '';
    transcriptInterimEl = null;
    showToast('Conversation cleared', 2500);
  });
  veil.on('ui:toggle-capture', async () => {
    const turningOn = !document.getElementById('stop-btn').classList.contains('active');
    if (turningOn) await startSystemAudio();
    await veil.captureToggle();
  });

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  let draggingWindow = false;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; veil.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    // While dragging, the window is moving under a stationary cursor, so
    // elementFromPoint briefly reports empty space — acting on that would make
    // the window click-through mid-gesture and drop the drag.
    if (draggingWindow) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim, #consent-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- window dragging ----------------------------------------------------
  // Done by hand instead of -webkit-app-region:drag, which cannot survive this
  // window's setIgnoreMouseEvents() toggling. Anywhere on the toolbar that is
  // not a control is a drag surface.
  const toolbarEl = document.getElementById('toolbar');
  if (toolbarEl) {
    toolbarEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button, #mode-menu')) return;
      e.preventDefault();

      draggingWindow = true;
      setIgnore(false); // must stay interactive for the whole gesture
      document.documentElement.classList.add('dragging');
      veil.dragStart(e.screenX, e.screenY);

      const onMove = (ev) => { if (draggingWindow) veil.dragMove(ev.screenX, ev.screenY); };
      const onUp = () => {
        draggingWindow = false;
        document.documentElement.classList.remove('dragging');
        veil.dragEnd();
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because Veil hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    veil.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  veil.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    setIgnore(false);
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionHelp = isWindows
    ? 'Veil needs permission to see and hear. Open Windows Privacy & security settings, allow <strong>Microphone</strong> and <strong>Screen recording</strong> for Veil, then come back here.'
    : 'Veil needs two macOS permissions. Click each button, turn <strong>Veil</strong> ON in the window that opens, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => veil.openPane('ms-settings:privacy-microphone') },
        { label: 'Open Screen recording settings', action: () => veil.openPane('ms-settings:privacy-screenrecorder') }
      ]
    : [
        { label: 'Open Microphone settings', action: () => veil.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => veil.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ];
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : '<span class="kbd">⌘</span> <span class="kbd">↵</span>';
  const solveShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">H</span>' : '<span class="kbd">⌘</span> <span class="kbd">H</span>';
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>';
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to Veil',
      body: 'Veil is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.<br><br>This quick guide gets you running in about a minute.'
    },
    {
      icon: '🔐',
      title: 'Allow Veil to see & hear',
      body: permissionHelp + '<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: permissionButtons
    },
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'Veil uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, or <span class="hl">Google Gemini</span>. Get a key from your provider, then paste it into Veil\'s Settings.<br><br><strong>Tip:</strong> For the <em>best</em> real-time listening, add a <span class="hl">Deepgram</span> key (lowest latency streaming transcription). Otherwise, an OpenAI key enables streaming via the Realtime API, and Gemini/Whisper work as batch fallbacks.',
      buttons: [{ label: 'Open Veil Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🫥',
      title: 'Stay hidden in Zoom',
      body: 'Veil is hidden from most screen shares automatically (Google Meet, Teams, QuickTime — nothing to do). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong><br><br>Avoid “<strong>without</strong> window filtering” — that mode reveals Veil.'
    },
    {
      icon: '✨',
      title: 'You’re all set',
      body: 'How to use Veil:<ul><li>' + assistShortcut + ' — <strong>Assist</strong> with whatever\'s on screen or being said</li><li>' + solveShortcut + ' — solve a coding problem on screen</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>Veil logo</strong>. Quit with ' + quitShortcut + '.'
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await veil.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await veil.settingsGet();
    const platformInfo = await veil.platformInfo();

    // R4: shortcut hints
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';

    // R5: prep status
    updatePrepStatus();
    // R6: smart tooltip
    updateSmartTooltip();
    // Fix 3: Adjust permission buttons based on actual Windows version.
    // ms-settings:privacy-screenrecorder only exists on Windows 11.
    // On Windows 10, screen capture needs no permission — so replace the button
    // with a more helpful note instead of an invalid settings link.
    if (isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000) {
      // Windows 10: update the onboarding screen recording button to be more helpful
      const ob = OB_STEPS[1];
      ob.buttons = ob.buttons.filter((b) => !b.label.toLowerCase().includes('screen'));
      ob.body = 'Veil needs microphone permission to hear you. Click the button below to open Windows microphone settings and allow Veil.<br><br><strong>Screen capture works automatically on Windows 10</strong> — no additional permission needed.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — works automatically on Windows 10</li></ul>';
    }

    smartBtn.classList.toggle('on', !!settings.smart);
    syncPlaceholder();

    // Fix placeholder shortcut hint to match platform
    if (isWindows) {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">Ctrl</span><span class="keycap">⏎</span> for Assist';
    }

    // Load persona modes + keybinds so the header switcher and shortcut hints are live
    try { modesState = await veil.modesList(); } catch (_) { /* ignore */ }
    updateModeButton(); rebuildModeMenu();
    try { const kb = await veil.keybindsGet(); if (kb && kb.binds) { keybindMap = kb.binds; keybindHeld = kb.held || {}; keybindMeta = kb.meta || []; } } catch (_) { /* ignore */ }
    refreshShortcutHints();
    try { const stl = await veil.stealthGet(); setStealthState(stl.on); } catch (_) { setStealthButton(true); }

    const st = await veil.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    $('#stop-btn').classList.toggle('active', st.active);
    setListenIcon(st.active);
    if (!settings.onboarded) showOnboard();
  })();
})();
