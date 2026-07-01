# pi-voice

Local streaming voice dictation for [pi](https://github.com/earendil-works/pi-coding-agent). Speak into the mic and the text lands in the prompt box — edited before you send, not auto-submitted.

- **Engine:** sherpa-onnx streaming Nemotron (0.6B, int8, 560 ms chunk) running on **CPU**. No GPU, no cloud.
- **Punctuation:** a small CNN-BiLSTM model re-punctuates the live partial (commas / periods / ?) and fixes casing as context builds, so the preview reads like a sentence, not a word soup.
- **Trigger:** push-to-talk (hold <kbd>Space</kbd> when the prompt is empty) **or** a hotkey toggle (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>) **or** the `/voice` command.
- **Mic can be remote:** `/voice-host <ssh-target>` runs `pw-record` over SSH and streams 16 kHz s16le back. Dictate from your laptop, run pi on your desktop. Set the default at startup with `PI_VOICE_HOST`.
- **Eye candy:** a live preview panel renders above the editor with a rainbow word gradient on the trailing words and a VU-meter cursor (▁▂▃▄▅▆▇█) that tracks your voice level.

> The rainbow/VU preview lives in a separate widget panel because pi's editor is plain text — the real caret can't be recolored, and color can't go inside the input box. (`ponytail:` from the source.)

## Requirements

- Linux with PipeWire (`pw-record` — part of `pipewire-tools` / `pulseaudio-utils` depending on distro)
- Node.js (the version pi runs on)
- A mic (default system source by default; pin one with `MIC_TARGET` in `index.ts`)
- ~700 MB free for the two models

## Install

### One-line from GitHub (once published)

```sh
pi install git:github.com/jbfly/pi-voice
```

The first `/voice` run downloads the models into the managed checkout automatically. To prefetch them manually:

```sh
cd ~/.pi/agent/git/github.com/jbfly/pi-voice
./fetch-models.sh   # downloads the two sherpa-onnx models into ./models/
```

### Manual (local clone for hacking)

```sh
git clone https://github.com/jbfly/pi-voice ~/git/pi-voice
cd ~/git/pi-voice
npm install
# point pi at it — symlink into its extensions dir under the name "voice":
ln -s ~/git/pi-voice ~/.pi/agent/extensions/voice
```

> Path note: the extension resolves its models at `<extdir>/models/…` by default. Move or share the models elsewhere and point at them with `PI_VOICE_MODELS` and `PI_VOICE_PUNCT` env vars.

## Models

Not shipped (≈700 MB total, and they're upstream Apache-2.0 weights). `fetch-models.sh` pulls the two dirs the code expects, into `models/`:

| Dir | Size | Use |
|---|---|---|
| `sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25` | ~650 MB | streaming ASR engine |
| `sherpa-onnx-online-punct-en-2024-08-06` | ~38 MB | live re-punctuation + casing |

If a download URL 404s, the ASR tarballs are catalogued at the [sherpa-onnx pretrained ASR models index](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html), and the punctuation tarball is listed in the [sherpa-onnx punctuation models index](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html). Drop the two dirs above into `models/` and you're set.

## Usage

| Action | How |
|---|---|
| Start/stop dictation | `/voice`, or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>, or hold <kbd>Space</kbd> |
| Route mic over SSH | `/voice-host laptop` (no arg = local mic) |
| Default SSH host on startup | `PI_VOICE_HOST=laptop pi` |

By default the recognized text is dropped into the prompt for you to edit before sending (`AUTO_SUBMIT = false` at the top of `index.ts`). Flip it to send automatically once you've got 3+ words.

### Self-checks (no mic needed)

```sh
node construct-check.js   # loads the model + decodes 1 s of silence — verifies install
node smoketest.js         # full pipeline: pw-record -> live partials (speak, Ctrl-C)
node partial-probe.js     # feeds a test wav in 100 ms chunks — shows how partials revise
```

## Config knobs (top of `index.ts`)

| Name | Default | What |
|---|---|---|
| `SHORTCUT` | `ctrl+alt+v` | hotkey toggle |
| `HOLD` | `true` | push-to-talk via held Space |
| `AUTO_SUBMIT` | `false` | auto-send the text instead of leaving it to edit |
| `PUNCTUATE` | `true` | live re-punctuation vs. raw Nemotron output |
| `MIC_TARGET` | `""` | PipeWire node name to pin a mic (empty = default source) |
| `RAINBOW_WORDS` | `4` | trailing words that get the gradient |

## How push-to-talk works (the Space heuristic)

Pi's terminal input gives raw bytes; a held <kbd>Space</kbd> emits byte `0x20` with a ~600 ms initial repeat delay then ~40 ms repeats. The extension starts dictation on the first Space when the prompt is empty (or still holds what you last dictated), gives an 800 ms release window for the initial gap, tightens to 150 ms once autorepeat is confirmed, and consumes all the Spaces so they never reach the editor. If you have your own draft in the box, Space behaves normally. It's a heuristic, not a real key-down/key-up event — but it's solid enough to lean on.

## SSH mic capture

When `PI_VOICE_HOST` (or `/voice-host`) is set, the extension spawns:

```
ssh <host> pw-record --rate=16000 --channels=1 --format=s16 --raw -
```

and pipes the raw s16le back over the SSH channel into the same streaming recognizer. So you dictate from a laptop whose mic you'd rather use, while pi runs on your desktop. Make sure `pw-record` is installed on the remote and SSH auth is keyless (agent/`ControlMaster`) — dictation starts the moment you press Space and there's no time for an interactive password prompt.

## License

Apache-2.0. The sherpa-onnx models retain their own upstream licenses (Apache-2.0 / NVIDIA terms — see the README in each model dir).
