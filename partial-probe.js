// Probe: feed a test wav in 100ms chunks, print every change to the live partial.
// Reveals whether the streaming model revises words / forms punctuation as context
// builds (like Claude), or only finalizes at the end.
const sherpa = require("sherpa-onnx-node");
const fs = require("node:fs");
const path = require("node:path");
const M = path.join(__dirname, "models", "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25");
const p = (f) => path.join(M, f);

const rec = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: p("encoder.int8.onnx"), decoder: p("decoder.int8.onnx"), joiner: p("joiner.int8.onnx") },
    tokens: p("tokens.txt"), numThreads: 4, provider: "cpu", debug: 0,
  },
  decodingMethod: "greedy_search",
  enableEndpoint: true, rule1MinTrailingSilence: 3.5, rule2MinTrailingSilence: 1.6, rule3MinUtteranceLength: 30,
});
const stream = rec.createStream();

const wav = fs.readFileSync(p("test_wavs/0.wav"));
const sr = wav.readUInt32LE(wav.indexOf("fmt ") + 12);
const dataStart = wav.indexOf("data") + 8;
const nSamples = (wav.length - dataStart) >> 1;
console.log(`wav: ${sr}Hz, ${(nSamples / sr).toFixed(1)}s; reference: ${JSON.stringify(fs.readFileSync(p("test_wavs/trans.txt"), "utf8").trim())}`);
console.log("--- partial evolution (only changes shown) ---");

const CHUNK = Math.round(sr * 0.1); // 100ms
let prev = "";
for (let off = 0; off < nSamples; off += CHUNK) {
  const end = Math.min(off + CHUNK, nSamples);
  const f = new Float32Array(end - off);
  for (let i = off; i < end; i++) f[i - off] = wav.readInt16LE(dataStart + i * 2) / 32768;
  stream.acceptWaveform({ sampleRate: sr, samples: f });
  while (rec.isReady(stream)) rec.decode(stream);
  const t = rec.getResult(stream).text;
  if (t !== prev) { console.log(`${((end / sr)).toFixed(1)}s  ${JSON.stringify(t)}`); prev = t; }
}
stream.acceptWaveform({ sampleRate: sr, samples: new Float32Array(sr) });
stream.inputFinished();
while (rec.isReady(stream)) rec.decode(stream);
console.log(`FINAL  ${JSON.stringify(rec.getResult(stream).text)}`);
