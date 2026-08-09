# Veil — Architecture

How the app is put together, what flows where, and why the boundaries sit where they do.

Veil is an Electron app with three inputs (screen, your microphone, the other side of the call), one document library, and one output: a streamed answer from the LLM provider you configured. There is no server anywhere in this picture — the only thing that leaves your machine is a single HTTPS request to the provider whose API key you supplied.

---

## The whole pipeline

```mermaid
flowchart TB
    subgraph IN["Inputs"]
        MIC["Microphone"]
        SYS["System audio<br/>(the other side of the call)"]
        SCR["Your screen"]
        DOCS["Documents you upload<br/>.md · .txt · .pdf"]
        TYPE["What you type"]
    end

    subgraph RENDERER["Renderer — browser context, sandboxed, no Node"]
        CAP["Audio capture<br/>AudioWorklet + getDisplayMedia"]
        UI["Glass overlay UI<br/>messages · action row · settings"]
    end

    BRIDGE{{"preload.js<br/>contextBridge — the only way across<br/>method allowlist out · event allowlist in"}}

    subgraph MAIN["Main process — Node, holds all privilege"]
        VAD["VAD + ring buffers<br/>src/vad.js"]
        STT["Speech to text<br/>Deepgram WS · OpenAI Realtime · Whisper · Gemini"]
        TR[("Transcript<br/>in memory only")]
        SHOT["Screenshot<br/>desktopCapturer"]
        ING["Ingest<br/>extract → chunk → persist"]
        IDX["BM25 index<br/>warmed in background"]
        RET["Retrieve top passages<br/>for this question"]
        ASM["Prompt assembly"]
        LLM["Provider stream<br/>src/llm.js"]
    end

    PROV(["Your LLM provider<br/>OpenAI · Anthropic · Gemini"])

    MIC --> CAP
    SYS --> CAP
    CAP -->|PCM frames| BRIDGE --> VAD --> STT --> TR
    SCR --> SHOT
    DOCS --> BRIDGE
    BRIDGE --> ING --> IDX
    TYPE --> UI --> BRIDGE

    TR --> ASM
    SHOT --> ASM
    IDX --> RET --> ASM
    ASM --> LLM <-->|HTTPS, your key| PROV
    LLM -->|token stream| BRIDGE --> UI

    style BRIDGE fill:#3C83F5,stroke:#2563EB,color:#fff
    style PROV fill:#1f2937,stroke:#4b5563,color:#fff
    style MAIN fill:#0f172a,stroke:#334155,color:#e2e8f0
    style RENDERER fill:#111827,stroke:#374151,color:#e2e8f0
    style IN fill:#111827,stroke:#374151,color:#e2e8f0
```

The single most important line in that diagram is the blue one. The renderer can reach the main process **only** through the methods `preload.js` chooses to expose, and the main process can push to the renderer **only** on channels that appear in a hardcoded allowlist. There is no `require`, no `fs`, and no `ipcRenderer` in the page itself.

---

## Process model

| | Runs | Can touch | Holds |
| --- | --- | --- | --- |
| **Main** (`main.js`, `src/`) | Node | Filesystem, network, OS shortcuts, screen capture | API keys in memory, the transcript, the document index |
| **Preload** (`preload.js`) | Isolated bridge context | `contextBridge`, `ipcRenderer` only | Nothing |
| **Renderer** (`renderer/`) | Sandboxed browser context | DOM, Web Audio, `getDisplayMedia` | Nothing durable |

The renderer is sandboxed (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`). It genuinely is just a web page — if it were fully compromised, the attacker's reach is the set of functions listed in `preload.js` and nothing more.

---

## Audio → transcript

```mermaid
flowchart LR
    A["Mic<br/>getUserMedia"] --> W["AudioWorklet<br/>16 kHz mono PCM"]
    B["System audio<br/>getDisplayMedia loopback"] --> W2["AudioWorklet"]
    W -->|mic:pcm| V1["VAD 'you'"]
    W2 -->|system:pcm| V2["VAD 'them'"]
    V1 --> R1[("ring buffer")] --> S
    V2 --> R2[("ring buffer")] --> S
    S{"Streaming key<br/>available?"}
    S -->|"Deepgram or OpenAI"| ST["WebSocket streaming STT<br/>interim + final"]
    S -->|"otherwise"| BA["Batch STT<br/>Whisper → Gemini fallback"]
    ST --> T[("Transcript<br/>you / them turns")]
    BA --> T
```

Two channels are tracked separately — `you` and `them` — because nearly everything downstream depends on knowing who said what. Question detection reads only `them` turns, and so does document retrieval.

The transcript lives in memory in the main process and is never written to disk. Closing the app loses it, deliberately.

---

## Documents → retrieved passages

Uploading a file does not send it anywhere. It is parsed locally, split into passages, and indexed locally.

```mermaid
flowchart TB
    F["File picker (main reads the path)<br/>or drag-drop (renderer sends bytes)"] --> V{"Validate<br/>extension · size · non-empty"}
    V -->|reject| ERR["Error shown in Settings"]
    V -->|.pdf| P["pdfjs-dist<br/>no eval, no network fonts"]
    V -->|.md .txt| U["UTF-8 decode, strip BOM"]
    P --> N["Normalise whitespace"]
    U --> N
    N --> C["Chunk ~900 chars, 150 overlap<br/>tagged with its markdown heading"]
    C --> D[("userData/context/&lt;id&gt;.json")]
    D --> BG["Background warm-up<br/>one document at a time, yielding"]
    BG --> I[("Inverted index<br/>term → Int32Array postings")]
    D -.->|"semantic search on"| EMB["Embed passages<br/>background, batched"]
    EMB -.-> V[("userData/context/&lt;id&gt;.vec<br/>float32, model-stamped")]

    Q["Question + last 3 'them' turns"] --> SR["BM25 over posting lists"]
    I --> SR
    SR --> G{"Matched terms carry<br/>≥ 1.5 × log(1+n) of information?"}
    G -->|no| KNONE["no keyword hits"]
    G -->|yes| KHITS["keyword ranking"]

    Q -.-> QV["Embed the question<br/>cached · 2.5s timeout"]
    V -.-> VS["Cosine ranking<br/>floor 0.32"]
    QV -.-> VS

    KHITS --> F["Reciprocal Rank Fusion"]
    KNONE --> F
    VS -.-> F
    F --> TOP["Top ≤6 passages, ≤3000 chars"]
    F --> NONE["Nothing, if neither retriever qualified"]
```

The dotted path is optional and off by default. Everything on it degrades to nothing: no key, no network, or a slow provider and the solid path answers on its own.

Three design points worth calling out:

**The index is warmed in the background at startup**, not lazily on the first question. Indexing a very large library takes seconds, and doing that when someone presses Assist mid-call would freeze the app and stall the answer. It is built one document at a time with a yield in between so nothing blocks.

**The relevance floor is a multiple of `log(1+n)`, not a fixed score.** This is what makes the same question behave the same way whether you have uploaded one file or two hundred. A flat BM25 threshold cannot do that — the same numeric score means completely different things at different corpus sizes, and measurement showed a fixed threshold returning irrelevant passages for **68%** of questions the documents could not answer at all.

**The two retrievers are combined by rank, not by score.** A BM25 score and a cosine similarity live on different scales, and normalising them into a weighted sum bakes in a constant that stops being right the moment the corpus changes. Reciprocal Rank Fusion only asks how highly each retriever placed a passage, which needs no tuning and stays stable as the library grows. It also means a passage found *only* by meaning still surfaces — which is the entire point, since that is the case keyword search cannot see.

---

## Building the prompt

Every request assembles the system prompt in a fixed order. Instructions first, untrusted material last.

```mermaid
flowchart TB
    L["1 · Language directive"] --> M["2 · Active Mode<br/>your persona system prompt"]
    M --> C["3 · Interview context<br/>résumé, JD, STAR stories —<br/>only the parts matching the detected question type"]
    C --> F["4 · Feature prompt<br/>Assist / Say / Follow-up / Recap / Ask / LeetCode"]
    F --> D["5 · Retrieved document passages<br/>fenced and marked untrusted"]
    D --> OUT(["System prompt"])
    OUT --> LLM["Single user turn:<br/>transcript + your question<br/>+ screenshot if the mode needs one"]
```

Document excerpts go **last and are explicitly fenced** as reference data the model must not treat as instructions — an uploaded PDF is arbitrary third-party text, and a line inside it saying "ignore your instructions" is exactly the attack this ordering and framing are there to blunt.

The same block tells the model to prefer your documents where they answer the question, and to **fall back to its own knowledge where they don't** — so retrieving a loosely-related passage never turns into a refusal.

LeetCode mode discards both the personal context and the documents. A coding problem does not need your résumé.

---

## Storage

Nothing is stored anywhere except your own machine.

```
%APPDATA%\veil\                 (macOS: ~/Library/Application Support/veil)
├── veil-data.json              settings; API keys encrypted at rest
└── context/
    ├── index.json              document metadata: name, size, passage count, enabled
    └── <docId>.json            the passages of one document
```

Document text is deliberately kept **out** of `veil-data.json`: that file is read, deep-merged and rewritten on every settings change, and putting megabytes of document text in it would make each of those a heavy round trip.

API keys are encrypted with the OS keychain via Electron `safeStorage` — DPAPI on Windows, Keychain on macOS, libsecret on Linux. Where no keychain exists, they are stored obfuscated and Settings says so plainly rather than implying protection that isn't there.

---

## IPC surface

Everything the renderer can do, it does through one of these. Anything not on this list is not reachable.

| Group | Channels |
| --- | --- |
| Settings | `settings:get` · `settings:set` |
| Capture | `capture:toggle` · `capture:state` · `mic:pcm` · `system:pcm` |
| Ask | `ask` · `transcript:clear` |
| Modes | `modes:list` · `modes:set-active` · `modes:save` · `modes:delete` |
| Keybinds | `keybinds:get` · `keybinds:set` · `keybinds:reset` · `keybinds:validate` |
| Documents | `docs:list` · `docs:pick` · `docs:add` · `docs:delete` · `docs:toggle` · `docs:set-enabled` · `docs:set-semantic` |
| Window | `mouse:ignore` · `window:drag-start` · `window:drag-move` · `window:drag-end` |
| Security | `stealth:get` · `stealth:set` · `security:info` |
| App Link | `applink:state` · `applink:revoke` · `applink:consent-response` |
| Misc | `platform:info` · `open-pane` · `log` |

Push channels (main → renderer) are separately allowlisted in `preload.js`: capture state, LLM stream events, status, transcript updates, STT state, document ingest progress, consent requests, and shortcut-driven UI actions. A channel not in that array is silently dropped, so a compromised renderer cannot subscribe to traffic it was never meant to see.

---

## Window behaviour

The overlay is a frameless, transparent, always-on-top window that is **click-through everywhere except the actual UI**. As your cursor moves, the renderer hit-tests what is under it and toggles `setIgnoreMouseEvents` — so empty space passes clicks to whatever is behind Veil.

That single behaviour is why dragging is implemented by hand rather than with `-webkit-app-region: drag`. An ignore-mouse window fails the OS hit-test that a drag region depends on, so the native approach either never started the drag or dropped it the moment the window moved. Instead, a pointer gesture on the toolbar sends `window:drag-*` to main, which repositions the window against an anchor captured at pointer-down. Because every move is computed from that fixed anchor rather than the previous position, rounding on fractionally-scaled displays cannot accumulate.

---

## Module map

| Path | Responsibility |
| --- | --- |
| `main.js` | Window, IPC, shortcuts, capture orchestration, prompt assembly |
| `preload.js` | The bridge — method allowlist out, event allowlist in |
| `src/llm.js` | Three providers behind one streaming interface |
| `src/stt.js`, `src/stt-streaming.js` | Batch and WebSocket transcription |
| `src/vad.js`, `src/wav.js` | Voice activity detection, ring buffers, WAV framing |
| `src/screen.js` | Screenshot capture |
| `src/prompts.js` | The six functional modes and their prompts |
| `src/modes.js` | Persona modes (user-editable system prompts) |
| `src/interview-context.js` | Question-type detection and profile context selection |
| `src/context-docs.js` | Chunking, tokenising, BM25, rank fusion — pure, no Electron, unit-tested |
| `src/context-store.js` | Document persistence, ingest, index warm-up, embedding job, retrieval |
| `src/embeddings.js` | Optional semantic vectors (OpenAI / Gemini) behind one interface |
| `src/pdf-text.js` | PDF text extraction, isolated so a bad PDF can't take ingest down |
| `src/keybinds.js` | Shortcut defaults, metadata, validation |
| `src/store.js` | JSON settings store with encrypted secrets |
| `src/applink.js` | Consent-gated local assistant access |
| `bench/` | Retrieval benchmark (not shipped in the packaged app) |

`src/context-docs.js` and `src/keybinds.js` deliberately import nothing from Electron. That is what lets them be unit-tested directly with `node --test`, and it is the pattern to follow for anything new with real logic in it.

---

## Testing

```bash
npm test               # 102 unit tests, node:test — no framework
npm run bench          # retrieval benchmark: latency, memory, recall, false-fire
npm run bench:huge     # adds a 76 MB / 143k-passage corpus
npm run bench:sweep    # the recall vs false-fire curve behind the relevance floor
npm run bench:semantic # the paraphrase gap; --embed to measure the semantic path
```

The benchmark exists because retrieval quality is not something you can eyeball. It plants facts in a synthetic corpus whose vocabulary follows a natural Zipf distribution, echoes each fact's topic words elsewhere so the retriever has to find the passage that actually answers rather than one that merely mentions the subject, and separately fires questions the corpus **cannot** answer to measure how often retrieval fires when it should stay silent.
