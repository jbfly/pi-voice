// Standalone STT pipeline smoke test: pw-record -> sherpa-onnx streaming Zipformer -> live partials.
// Run: node smoketest.js   (speak into the mic; Ctrl-C to stop)
const sherpa = require("sherpa-onnx-node");
const { spawn } = require("node:child_process");
const path = require("node:path");

const M = path.join(__dirname, "models", "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25");
const p = (f) => path.join(M, f);

const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: p("encoder.int8.onnx"),
      decoder: p("decoder.int8.onnx"),
      joiner: p("joiner.int8.onnx"),
    },
    tokens: p("tokens.txt"),
    numThreads: 4,
    provider: "cpu",
    debug: 0,
  },
  decodingMethod: "greedy_search",
  enableEndpoint: true,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 1.2,
  rule3MinUtteranceLength: 20,
});
console.error("[ok] recognizer built (model loaded)");

const stream = recognizer.createStream();
const rec = spawn("pw-record", ["--rate=16000", "--channels=1", "--format=s16", "--raw", "-"], {
  stdio: ["ignore", "pipe", "inherit"],
});
rec.on("error", (e) => { console.error("[FAIL] pw-record:", e.message); process.exit(1); });

let chunks = 0, last = "";
rec.stdout.on("data", (buf) => {
  chunks++;
  const n = buf.length >> 1;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
  stream.acceptWaveform({ sampleRate: 16000, samples: f });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const t = recognizer.getResult(stream).text;
  if (t !== last) { last = t; process.stderr.write("\r\x1b[2K  ▶ " + t); }
  if (recognizer.isEndpoint(stream)) {
    if (t.trim()) process.stderr.write("\n  ✓ " + t.trim() + "\n");
    recognizer.reset(stream); last = "";
  }
});
console.error("[ok] mic capture started — 🎤 speak now (Ctrl-C to stop)");
process.on("SIGINT", () => { rec.kill("SIGINT"); console.error(`\n[done] ${chunks} audio chunks processed`); process.exit(0); });
