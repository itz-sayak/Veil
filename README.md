# Veil

**An open-source AI copilot that floats over your screen — sees what you see, hears your meetings, reads your documents, and stays hidden from screen shares.**

Veil is a private, self-hosted alternative to Cluely. It runs entirely on your machine as a floating glass overlay: it can look at your screen, transcribe your microphone and the other side of a call, ground its answers in documents you upload, and stream replies from the LLM of your choice. It has **no backend** — the only network calls are the ones your chosen AI provider requires, made directly from your device with **your own** API key.

For how the pieces fit together — with diagrams — see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Features

- **Assist** — one keypress reads your screen and the recent conversation and gives you exactly what you need, no preamble.
- **What should I say?** — drafts the next thing to say in a live conversation.
- **Follow-up / Recap** — suggests questions to ask, or summarises the whole conversation.
- **Solve on screen** — screenshots a coding problem and returns approach, solution, and complexity.
- **Context documents** — upload `.md`, `.txt` and `.pdf` files and Veil answers from them. See [below](#context-documents).
- **Live transcription** — microphone and system audio (the other side of a call) via Deepgram streaming, OpenAI Realtime/Whisper, or Gemini.
- **Modes** — selectable persona profiles, each with its own editable system prompt.
- **Custom keybindings** — remap every global shortcut.
- **Undetectability** — excluded from screen shares and recordings, hidden from the taskbar, cross-platform, with a toggle.
- **Smart toggle** — flip between a fast/cheap model and a smarter/slower one per provider.
- **Your keys, encrypted** — API keys stay on your device, encrypted at rest with your OS keychain.

---

## Context documents

Drop `.md`, `.txt` or `.pdf` files into **Settings → Context** and Veil will answer from them.

It does not stuff whole files into the prompt. For each question it finds the handful of passages that actually bear on what was asked and includes only those. That matters because Veil answers in real time during live calls — pasting a 40-page PDF into every request would make it slow and expensive, whereas a few hundred words of the *right* passage costs almost nothing.

**How it decides what's relevant.** Files are split into ~900-character passages (tagged with their markdown headings), indexed with BM25, and searched against your question plus the last few things the other person said. If nothing scores well enough, nothing is added — Veil stays quiet rather than padding the prompt with noise.

### Semantic search (optional)

Keyword search is exact, instant and free, and it is excellent when your question reuses the document's own words. It is completely blind when it doesn't. Ask *"what's our uptime promise?"* of a handbook that only ever says *"service level agreement guarantees 99.95% availability"* and there is not one content word in common — BM25 scores it zero.

That gap is measurable. On a ten-passage handbook where every fact can be asked two ways (`npm run bench:semantic`):

| Question worded... | Keyword only |
| --- | --- |
| using the document's own words | **10/10** |
| paraphrased | **1/10** |

Turning on **Settings → Context → Semantic search** adds a second retriever that compares *meaning* instead of spelling. Both retrievers run and their rankings are combined, so semantic reach is added without giving up the precision keyword search already had.

**What it costs.** One embedding call per document when you add it, and a small one per question. It is **off by default**, because it spends your API credit and that should be your decision rather than a surprise on your next bill. Embeddings are far cheaper than chat — this is cents, not pounds.

#### Which keys give you what

Answers work with any of the three providers. Semantic search needs one that can produce embeddings, and **Anthropic doesn't publish an embeddings endpoint** — that's a gap in their API, not a choice Veil made.

| Keys you hold | Answers | Semantic search |
| --- | --- | --- |
| Anthropic only | ✅ | ❌ keyword only |
| OpenAI only | ✅ | ✅ via OpenAI |
| Gemini only | ✅ | ✅ via Gemini |
| Anthropic **+** OpenAI | ✅ | ✅ via OpenAI |
| Anthropic **+** Gemini | ✅ | ✅ via Gemini |
| Any two or three | ✅ | ✅ |

So being on Claude doesn't shut you out. Add an OpenAI or Gemini key alongside your Anthropic one and you keep chatting with Claude while embeddings quietly come from the other provider — Veil prefers your chat provider for embeddings when it can and falls back to whichever key is able to do the job. Since embeddings cost a tiny fraction of what chat does, that second key barely registers on a bill.

If you're Anthropic-only, the Context screen says so plainly instead of offering a toggle that can't work, and you keep full keyword retrieval — which scores 10/10 on literally-worded questions.

**How it fails.** Safely, in every direction. No key, network down, or provider slow (past 2.5s) and the question is simply answered with keyword retrieval — it never delays a live call waiting on an embedding. Documents are keyword-searchable the instant they're added; embedding catches up in the background. Switching provider marks the stored vectors unusable and re-embeds rather than comparing vectors from two different models. Turning the setting off deletes the vectors from disk.

Under the hood it is Reciprocal Rank Fusion over the two rankings — deliberately rank-based, because a BM25 score and a cosine similarity are not on comparable scales and any weighted sum of them bakes in a constant that stops being correct as soon as the corpus changes.

### What if the answer isn't in your documents?

**Veil still answers — using the model's own knowledge, over the normal API call.** Uploading documents adds grounding; it never restricts what Veil is allowed to answer. There are three cases, and you don't have to do anything to switch between them:

| What happened | What Veil does |
| --- | --- |
| Nothing in your files matched the question | Adds nothing to the prompt and answers normally from the model's own knowledge — exactly as if you'd uploaded nothing at all |
| Your files matched **and** contain the answer | Prefers your documents over what the model thinks it knows, and won't contradict them |
| Your files matched but **don't** actually contain the answer | Falls back to the model's own knowledge and answers anyway |

So asking "explain how B-trees work" while your uploaded files are all about your company's billing policy gets you a normal, complete answer about B-trees. Veil will **never** reply "that isn't in your documents" and stop there — that's a real failure mode for this kind of feature, and it's explicitly instructed against.

The one thing it won't do is *invent* things and attribute them to your files: it won't claim your handbook says something it doesn't.

Everything stays on your machine. Files are parsed locally, indexed locally, and only the selected excerpts are sent — with the request you made, to the provider you configured. LeetCode mode ignores documents entirely.

### Does it hold up on a big library?

There is a real benchmark in [`bench/`](bench/), because retrieval quality is not something you can eyeball:

```bash
npm run bench          # standard scales
npm run bench:huge     # adds a 76 MB / 143,000-passage corpus
npm run bench:sweep    # the recall vs false-positive curve behind the relevance threshold
```

Measured on synthetic corpora with natural (Zipf) vocabulary, where each planted fact's topic words are echoed elsewhere so the retriever has to find the passage that *answers* rather than one that merely mentions the subject:

| Library | Passages | Correct passage ranked #1 | Fired on unanswerable questions | Query time (p99) |
| --- | --- | --- | --- | --- |
| 5 files, 0.1 MB | 105 | 100% | 0.5% | 0.07 ms |
| 25 files, 2.4 MB | 4,468 | 100% | 0% | 0.09 ms |
| 50 files, 19 MB | 35,795 | 100% | 0% | 0.65 ms |
| 200 files, 76 MB | 143,249 | 100% | 0% | 2.55 ms |

Indexing a library that large takes a few seconds, so it happens **in the background at startup** — not on your first question. Ask something the documents can't answer and retrieval stays silent instead of guessing.

---

## Modes (persona system prompts)

A **Mode** is a named profile whose system prompt is prepended to every response, shaping *who Veil is being for you* right now. It composes on top of the functional feature (Assist, Say, …), which decides *how* to answer.

Built-in modes, all editable: **Default** (no persona), **General**, **Looking for a job**, **Sales call**, **Meeting**, and **User Instructions** (your own always-on prompt). Create, edit and delete your own in **Settings → Modes**, and switch instantly from the mode pill in the top bar.

## Keybindings

Every global shortcut is remappable in **Settings → Keybinds** — click a shortcut, press the new keys. Changes take effect immediately; the old combination is released and the new one registered on the spot. If another application already owns a combination, Veil says so instead of silently doing nothing.

| Action | Default (Win/Linux) |
| --- | --- |
| Toggle visibility | `Ctrl + \` |
| Ask / Assist about screen | `Ctrl + Enter` |
| What should I say? | `Ctrl + Shift + Enter` |
| Solve problem on screen | `Ctrl + H` |
| Clear conversation | `Ctrl + R` |
| Start / stop listening | `Ctrl + Shift + \` |
| Move window ↑ ↓ ← → | `Ctrl + Arrow` |
| Scroll response ↑ ↓ | `Ctrl + Shift + Arrow` |
| Quit | `Ctrl + Shift + X` |

On macOS, `Ctrl` maps to `⌘`. "Reset to defaults" restores the table above.

## Undetectability

**Settings → Security → Undetectability** (on by default) excludes Veil from screen capture using each OS's native mechanism:

- **macOS** — `NSWindowSharingNone`.
- **Windows** — `WDA_EXCLUDEFROMCAPTURE` (Windows 10 build 19041 / 2004 or newer). On older builds the window cannot be hidden, and Veil tells you.
- **Linux** — best effort: hidden from the taskbar and kept on top; capture exclusion depends on your compositor.

This is **best effort, not a guarantee.** Some capture paths still see the window — notably Zoom's advanced capture *without* window filtering, and certain modes on macOS 15.4+. Settings carries the same warning. Set `VEIL_NO_PROTECT=1` to force it off.

---

## Requirements

- **Node.js ≥ 22.12**
- An API key from **OpenAI**, **Anthropic**, or **Google Gemini**. Optionally a **Deepgram** key for the lowest-latency streaming transcription.

## Install & run

```bash
npm install        # also brands the local Electron binary as "Veil" on Windows
npm start          # run in development
npm test           # 83 unit tests (node:test, no framework)
```

On first launch a short walkthrough covers permissions (Microphone, Screen Recording) and adding your API key.

> If `npm start` opens nothing, check that `ELECTRON_RUN_AS_NODE` is not set in your environment — it makes Electron boot as plain Node.

### Package a build

```bash
npm run dist:win   # Windows
npm run dist:mac   # macOS (ad-hoc unless signing env vars are set — see electron-builder.cjs)
```

---

## Privacy & data

- **No servers, no telemetry.** Requests go straight from your machine to the provider whose key you supplied. Veil has no backend to send anything to.
- **API keys** live only on this device in `veil-data.json` (`%APPDATA%\veil` on Windows, `~/Library/Application Support/veil` on macOS), **encrypted at rest** with your OS keychain via Electron `safeStorage`. Where no keychain exists (some Linux setups) they are stored obfuscated and Settings says so plainly rather than implying protection that isn't there.
- **Your documents** never leave your machine. They are parsed and indexed locally in `%APPDATA%\veil\context\`; only the specific excerpts relevant to a question travel with that request.
- **Transcripts** are held in memory only and are never written to disk. Closing Veil discards them.

---

## Security

Veil holds three genuinely sensitive things: your API keys, a live transcript of your conversations, and whatever documents you uploaded. The design assumes the renderer is the part most likely to be attacked, and keeps all three out of it.

**Process isolation.** The renderer runs fully sandboxed — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. It has no `require`, no filesystem, and no direct IPC. It is a web page with no ambient authority, so a compromise there reaches only the functions deliberately exposed to it.

**A bridge that allowlists in both directions.** `preload.js` exposes a fixed set of methods and nothing else. Push channels from main to renderer are matched against a hardcoded array, and anything not on it is dropped — a compromised renderer cannot subscribe to IPC traffic it was never meant to see. Every handler validates its own payload rather than trusting the caller.

**No renderer-supplied paths.** The document file picker runs entirely in the main process, so the renderer never names a file on disk. Drag-and-drop sends the *bytes* the page already read rather than a path the main process would have to resolve. Document ids are generated in main, validated against a strict pattern, and every file path is rebuilt from that id — a document cannot be made to point outside its own directory.

**Untrusted content is treated as untrusted.** An uploaded PDF is arbitrary third-party text. Retrieved excerpts are placed *after* all instructions in the prompt and explicitly fenced as reference data the model must not obey — so a line inside a document saying "ignore your previous instructions" is framed as data, not command. PDFs are parsed with scripting and `eval` disabled and no network font fetches, in an isolated module so a malformed file fails as one bad upload rather than taking ingest down. Uploads are capped by extension, file size, and document count.

**A strict Content-Security-Policy** (`default-src 'self'`, `connect-src 'self'`) means the UI cannot load or reach anything remote. All provider network calls happen in the main process.

**`openExternal` is restricted** to OS-settings deep links (`ms-settings:`, `x-apple.systempreferences:`) — the renderer cannot ask the OS to open arbitrary URLs.

**Consent-gated assistant access.** Other local programs can ask what Veil is doing, but only through an explicit consent prompt, and the response never includes transcript text, résumé content, or API keys — only whether keys are set.

**Things removed rather than kept.** The upstream project shipped a disguise that impersonated "Microsoft Edge Update" / "Microsoft Corporation", including Edge's icon; that was deceptive and tripped antivirus heuristics, and it is gone — Veil brands honestly as itself while keeping the legitimate capture-exclusion feature. An autonomous auto-patch GitHub workflow that fed externally-controlled input into a write-scoped agent was also removed.

### Known dependency advisories

Tracked deliberately rather than force-upgraded, because breaking the app untested is worse than a documented risk:

- `electron@33` carries upstream Chromium advisories. The patched line is Electron 43 — a major upgrade needing full re-testing of capture, sandbox and stealth before adoption. Pinned to 33 for stability.
- `uuid` (moderate) reaches the tree only via `@google/genai` → `google-auth-library` → `gaxios`, on the Gemini path. Fixing it requires a major `@google/genai` bump.
- `pdfjs-dist` pulls `@napi-rs/canvas` as an optional native dependency. Veil only extracts text and never touches the canvas path, so it is unused at runtime.

---

## Responsible use

Veil can hide itself from screen shares. **Do not use it during a proctored exam, a job interview, or any recorded or monitored meeting where it would break the rules, terms of service, or the consent and recording laws that apply to you.** You are responsible for how you use it.

---

## Tech

Electron, no framework, no bundler.

- `main.js` — main process: capture, STT routing, prompt assembly, LLM streaming, shortcuts, stealth
- `preload.js` — the locked-down `contextBridge` API
- `renderer/` — the glass UI (plain DOM, no framework)
- `src/` — providers, prompts, modes, keybinds, document retrieval, storage
- `bench/` — retrieval benchmark (not shipped in the packaged app)

Full breakdown with diagrams in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## License

GPL-3.0-or-later.

---

## Roadmap

Things that are known-imperfect and worth doing next:

- **Electron 43.** Pinned to 33 for stability; the upgrade needs capture, sandbox and stealth re-tested end to end.
- **An app icon.** Builds currently ship the default Electron icon.
- **Unbinding from the UI.** The backend supports clearing a shortcut; the Keybinds screen has no control for it yet.
- **More document formats.** `.docx` and OCR for scanned PDFs are the obvious gaps.
