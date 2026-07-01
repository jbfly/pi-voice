// No-mic validation: build the recognizer + decode 1s of silence. Confirms the
// model loads and the API works under pi's Node WITHOUT opening the mic (so it
// won't flip the BT headset to HFP / disturb music).
const sherpa = require("sherpa-onnx-node");
const path = require("node:path");
const M = path.join(__dirname, "models", "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25");
const p = (f) => path.join(M, f);

const r = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: p("encoder.int8.onnx"), decoder: p("decoder.int8.onnx"), joiner: p("joiner.int8.onnx") },
    tokens: p("tokens.txt"), numThreads: 4, provider: "cpu", debug: 0,
  },
  decodingMethod: "greedy_search",
  enableEndpoint: true,
  rule1MinTrailingSilence: 3.0, rule2MinTrailingSilence: 1.4, rule3MinUtteranceLength: 20,
});
const s = r.createStream();
s.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000) }); // 1s silence
while (r.isReady(s)) r.decode(s);
console.log("[ok] Nemotron model loaded + decoded; silent result:", JSON.stringify(r.getResult(s).text));
