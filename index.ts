// Local streaming voice dictation for pi.
// Push-to-talk (hold space) OR toggle (Ctrl+Alt+V / /voice) -> pw-record mic ->
// sherpa-onnx streaming Nemotron (CPU, accurate words + casing) -> live re-punctuation
// (commas/periods/? form as context builds) -> rainbow preview + VU cursor -> text
// dropped into the prompt to edit before sending.
//
// PTT via the space-autorepeat heuristic through ghostty+tmux. Measured here: space =
// raw byte 0x20, ~600ms initial repeat delay then ~40ms repeats. Start on the first
// space when the prompt is empty (or still holds what we last dictated, so you can hold
// space again to continue), 800ms release window for the initial gap, tighten to 150ms
// once autorepeat is confirmed, consume all spaces.
//
// ponytail: preview + cursor live in a setWidget panel — pi's editor is plain text, so
// the real caret can't be recolored/resized and color can't go in the input box.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sherpa = require("sherpa-onnx-node");

// Resolves <repo>/models by default; override per-host with PI_VOICE_MODELS / PI_VOICE_PUNCT.
const _path = require("node:path");
const MODELS = process.env.PI_VOICE_MODELS || _path.join(__dirname, "models", "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25");
const PUNCT = process.env.PI_VOICE_PUNCT || _path.join(__dirname, "models", "sherpa-onnx-online-punct-en-2024-08-06");
const PUNCTUATE = true;       // re-punctuate live (commas/periods/?/casing form as context builds); false => Nemotron-native
const SHORTCUT = "ctrl+alt+v";
const MIC_TARGET = "";        // "" = system default source (the BT mic). Set a pw node name to pin a mic.
const AUTO_SUBMIT = false;    // true => send when >=3 words; false => edit-before-send
const HOLD = true;            // hold space = push-to-talk
const INITIAL_RELEASE_MS = 800;
const REPEAT_RELEASE_MS = 150;
const REPEAT_THRESHOLD_MS = 120;
const PUNCT_THROTTLE_MS = 180; // re-punctuate the live partial at most this often
const BLOCKS = "▁▂▃▄▅▆▇█";
const RAINBOW_WORDS = 4;
const SAT = 0.8;

export default function voiceDictation(pi: ExtensionAPI): void {
  let ctxRef: ExtensionContext | undefined;
  let recognizer: any;
  let punct: any;             // undefined = not built; null = build failed
  let stream: any;
  let rec: ChildProcess | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubKeys: (() => void) | undefined;
  let starting = false;
  let finals = "";
  let partial = "";
  let recording = false;
  let vu = 0;
  let prefix = "";
  let sep = "";
  let committedText = "";
  let shownText = "";         // punctuated live text (throttled)
  let lastPunct = 0;
  // push-to-talk state
  let pttActive = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSpace = 0;
  // "" = local mic. Else ssh args (e.g. "laptop" or "-p 2222 user@host"): run pw-record THERE,
  // stream s16le back over SSH. Switch live with /voice-host. Seeded from $PI_VOICE_HOST.
  let captureHost = (process.env.PI_VOICE_HOST || "").trim();
  let sawRepeat = false;

  function uiOk(c: ExtensionContext | undefined): c is ExtensionContext {
    if (!c) return false;
    try { return c.hasUI; } catch { ctxRef = undefined; return false; }
  }

  function buildRecognizer(): void {
    if (recognizer) return;
    const p = (f: string) => `${MODELS}/${f}`;
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: p("encoder.int8.onnx"), decoder: p("decoder.int8.onnx"), joiner: p("joiner.int8.onnx") },
        tokens: p("tokens.txt"), numThreads: 4, provider: "cpu", debug: 0,
      },
      decodingMethod: "greedy_search",
      enableEndpoint: true,
      rule1MinTrailingSilence: 3.5, rule2MinTrailingSilence: 1.6, rule3MinUtteranceLength: 30,
    });
  }

  const modelFiles = () => [
    `${MODELS}/encoder.int8.onnx`,
    `${MODELS}/decoder.int8.onnx`,
    `${MODELS}/joiner.int8.onnx`,
    `${MODELS}/tokens.txt`,
  ];

  const hasModels = () => modelFiles().every(existsSync);

  async function fetchModels(c: ExtensionContext): Promise<boolean> {
    const script = _path.join(__dirname, "fetch-models.sh");
    if (!existsSync(script)) {
      try { c.ui.notify("voice: missing models and fetch-models.sh is not installed", "error"); } catch {}
      return false;
    }
    if (process.env.PI_VOICE_MODELS || process.env.PI_VOICE_PUNCT) {
      try { c.ui.notify("voice: model env path is missing; unset PI_VOICE_MODELS/PI_VOICE_PUNCT or fix the path", "error"); } catch {}
      return false;
    }
    try {
      c.ui.notify("voice: downloading models (~700 MB); first run may take a while", "info");
      c.ui.setStatus("voice", c.ui.theme.fg("accent", "voice: downloading models"));
    } catch {}
    return await new Promise<boolean>((resolve) => {
      let tail = "";
      let done = false;
      const finish = (ok: boolean, msg?: string) => {
        if (done) return;
        done = true;
        try { c.ui.setStatus("voice", undefined); } catch {}
        if (!ok) try { c.ui.notify(`voice: model download failed${msg ? `: ${msg}` : ""}`, "error"); } catch {}
        resolve(ok);
      };
      const remember = (b: Buffer) => { tail = (tail + b.toString()).slice(-2000); };
      const dl = spawn("bash", [script], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
      dl.stdout?.on("data", remember);
      dl.stderr?.on("data", remember);
      dl.on("error", (e) => finish(false, e.message));
      dl.on("close", (code) => finish(code === 0, code === 0 ? undefined : (tail.trim() || `exit ${code}`)));
    });
  }

  async function ensureModels(c: ExtensionContext): Promise<boolean> {
    if (hasModels()) return true;
    if (!(await fetchModels(c))) return false;
    const ok = hasModels();
    if (!ok) try { c.ui.notify("voice: model download finished, but expected files are still missing", "error"); } catch {}
    return ok;
  }

  function buildPunct(): void {
    if (!PUNCTUATE || punct !== undefined) return;
    try {
      punct = new sherpa.OnlinePunctuation({
        model: { cnnBilstm: `${PUNCT}/model.int8.onnx`, bpeVocab: `${PUNCT}/bpe.vocab`, numThreads: 1, provider: "cpu", debug: 0 },
      });
    } catch { punct = null; }
  }

  const liveText = () => (finals + " " + partial).trim();

  // re-punctuate: model wants lowercase, no existing punctuation.
  function punctuate(s: string): string {
    if (!PUNCTUATE || !punct || !s) return s;
    try { return punct.addPunct(s.toLowerCase().replace(/[.,?!:;…]+/g, "")); } catch { return s; }
  }

  function hue(h: number, ch: string): string {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f, t = f;
    let r = 0, g = 0, b = 0;
    switch (i % 6) {
      case 0: r = 1; g = t; b = 0; break;
      case 1: r = q; g = 1; b = 0; break;
      case 2: r = 0; g = 1; b = t; break;
      case 3: r = 0; g = q; b = 1; break;
      case 4: r = t; g = 0; b = 1; break;
      default: r = 1; g = 0; b = q; break;
    }
    r = 1 - SAT + SAT * r; g = 1 - SAT + SAT * g; b = 1 - SAT + SAT * b;
    return `\x1b[38;2;${Math.round(r * 255)};${Math.round(g * 255)};${Math.round(b * 255)}m${ch}\x1b[39m`;
  }

  function cursor(): string {
    const lvl = Math.min(7, Math.max(0, Math.floor(vu * 8)));
    return hue(Date.now() / 700, BLOCKS[lvl]);
  }

  function styled(s: string): string {
    const words = s.split(" ");
    const phase = Date.now() / 900;
    const from = Math.max(0, words.length - RAINBOW_WORDS);
    let out = "", ci = 0;
    for (let w = 0; w < words.length; w++) {
      if (w > 0) { out += " "; ci++; }
      const word = words[w];
      if (w < from) { out += word; ci += word.length; }
      else for (const ch of word) out += hue(phase + ci++ * 0.04, ch);
    }
    return out;
  }

  function render(): void {
    const c = ctxRef;
    if (!uiOk(c)) return;
    try {
      if (recording) {
        const raw = liveText();
        const now = Date.now();
        if (raw && now - lastPunct > PUNCT_THROTTLE_MS) { lastPunct = now; shownText = punctuate(raw); }
        const display = shownText || raw; // only the new utterance (resume keeps old text in the box)
        const body = display ? styled(display) + " " : c.ui.theme.fg("dim", "listening… ");
        c.ui.setWidget("voice", [body + cursor()], { placement: "aboveEditor" });
        c.ui.setStatus("voice", c.ui.theme.fg("accent", "🎤 rec"));
      } else {
        c.ui.setWidget("voice", undefined);
        c.ui.setStatus("voice", undefined);
      }
    } catch { /* transient repaint race; next tick recovers */ }
  }

  function feed(buf: Buffer): void {
    if (!recording || !stream) return;
    const n = buf.length >> 1;
    const f = new Float32Array(n);
    let sumSq = 0;
    for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2) / 32768; f[i] = s; sumSq += s * s; }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    const level = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-9) + 60) / 60));
    vu = level > vu ? level : vu * 0.8 + level * 0.2;
    stream.acceptWaveform({ sampleRate: 16000, samples: f });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    partial = recognizer.getResult(stream).text;
    if (recognizer.isEndpoint(stream)) {
      const tx = recognizer.getResult(stream).text.trim();
      if (tx) finals = (finals + " " + tx).trim();
      partial = "";
      recognizer.reset(stream);
    }
  }

  async function start(c: ExtensionContext, hold = false): Promise<void> {
    if (recording || starting) return;
    if (!uiOk(c) || c.mode !== "tui") return;
    ctxRef = c;
    starting = true;
    try {
      if (!(await ensureModels(c))) return;
      try { buildRecognizer(); buildPunct(); } catch (e) {
        try { c.ui.notify("voice: failed to load model — " + (e as Error).message, "error"); } catch {}
        return;
      }
      try { prefix = c.ui.getEditorText(); } catch { prefix = ""; }
      sep = prefix && !prefix.endsWith(" ") ? " " : "";
      recording = true; finals = ""; partial = ""; vu = 0; shownText = ""; lastPunct = 0;
      stream = recognizer.createStream();
      const args = ["--rate=16000", "--channels=1", "--format=s16", "--raw"];
      if (MIC_TARGET) args.push(`--target=${MIC_TARGET}`);
      args.push("-");
      const remote = captureHost.split(/\s+/).filter(Boolean);
      rec = remote.length
        ? spawn("ssh", [...remote, "pw-record", ...args], { stdio: ["ignore", "pipe", "ignore"] })
        : spawn("pw-record", args, { stdio: ["ignore", "pipe", "ignore"] });
      rec.stdout?.on("data", (chunk: Buffer) => { try { feed(chunk); } catch { /* keep streaming */ } });
      rec.on("error", () => { try { ctxRef?.ui.notify("voice: pw-record failed", "error"); } catch {} stop(false); });
      if (!timer) timer = setInterval(render, 50);
      render();
      if (hold) armRelease(INITIAL_RELEASE_MS);
    } finally {
      starting = false;
    }
  }

  function stop(insert: boolean): void {
    if (!recording) return;
    recording = false;
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = undefined; }
    if (timer) { clearInterval(timer); timer = undefined; }
    if (rec) { try { rec.kill("SIGINT"); } catch {} rec = undefined; }
    if (stream) {
      try {
        stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) });
        stream.inputFinished();
        while (recognizer.isReady(stream)) recognizer.decode(stream);
        const tail = recognizer.getResult(stream).text.trim();
        if (tail) finals = (finals + " " + tail).trim();
        partial = "";
      } catch {}
    }
    const text = punctuate(liveText());
    const composed = text ? prefix + sep + text : prefix;
    const c = ctxRef;
    if (uiOk(c)) {
      try {
        if (insert && text && AUTO_SUBMIT && text.split(/\s+/).length >= 3) {
          pi.sendUserMessage(text); committedText = "";
        } else if (insert && text) {
          c.ui.setEditorText(composed); committedText = composed;
        }
      } catch {}
    }
    finals = ""; partial = ""; vu = 0; shownText = ""; stream = undefined;
    render();
  }

  function toggle(c: ExtensionContext): void {
    ctxRef = c; pttActive = false;
    if (recording) stop(true); else void start(c);
  }

  function armRelease(ms: number): void {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      if (recording && pttActive) { pttActive = false; sawRepeat = false; stop(true); }
    }, ms);
  }

  function onInput(data: string): { consume?: boolean } | undefined {
    const c = ctxRef;
    if (!HOLD || !uiOk(c) || c.mode !== "tui") return undefined;
    if (!data || !/^ +$/.test(data)) return undefined;
    const now = Date.now();
    if (recording) {
      if (pttActive) {
        if (now - lastSpace < REPEAT_THRESHOLD_MS) sawRepeat = true;
        lastSpace = now;
        armRelease(sawRepeat ? REPEAT_RELEASE_MS : INITIAL_RELEASE_MS);
      }
      return { consume: true };
    }
    let cur = "";
    try { cur = c.ui.getEditorText(); } catch { return undefined; }
    if (cur !== "" && cur !== committedText) return undefined; // your own draft => normal space
    pttActive = true; sawRepeat = false; lastSpace = now;
    void start(c, true);
    return { consume: true };
  }

  pi.registerShortcut(SHORTCUT, { description: "Toggle voice dictation", handler: (c) => toggle(c) });
  pi.registerCommand("voice", { description: "Start/stop local voice dictation (sherpa-onnx, CPU)", handler: async (_a, c) => toggle(c) });
  pi.registerCommand("voice-host", {
    description: "Route mic over SSH: /voice-host <ssh-target> (no arg = local mic)",
    handler: async (a, c) => {
      captureHost = (a ?? "").trim();
      try { c.ui.notify(captureHost ? `voice: mic via ssh ${captureHost}` : "voice: local mic", "info"); } catch {}
    },
  });

  pi.on("session_start", async (_e, c) => {
    ctxRef = c;
    if (HOLD && uiOk(c) && c.mode === "tui" && c.ui.onTerminalInput && !unsubKeys) {
      try { unsubKeys = c.ui.onTerminalInput(onInput); } catch {}
    }
  });
  pi.on("session_shutdown", async (_e, c) => {
    ctxRef = c;
    stop(false);
    if (unsubKeys) { try { unsubKeys(); } catch {} unsubKeys = undefined; }
    try { c.ui.setStatus("voice", undefined); c.ui.setWidget("voice", undefined); } catch {}
  });
}
