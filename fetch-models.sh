#!/usr/bin/env bash
# Downloads the two sherpa-onnx models this extension needs, into ./models/.
#   1. streaming Nemotron ASR (int8, ~650 MB) — the dictation engine
#   2. online CNN-BiLSTM punctuation (int8, ~38 MB) — live re-punctuation
#
# The packaged model dirs from k2-fsa ship as tar.bz2 release assets. If those
# exact URLs move, see the catalog: https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html
# — the directory names below are what the code expects.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models

have() { [ -d "models/$1" ] && [ -n "$(ls -A "models/$1" 2>/dev/null)" ]; }

ASR_DIR="sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25"
PUNCT_DIR="sherpa-onnx-online-punct-en-2024-08-06"
ASR_GH="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
PUNCT_GH="https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models"

dl() {  # dl <url> <out>
  if command -v wget >/dev/null 2>&1; then wget -O "$2" "$1"
  else curl -fL -o "$2" "$1"; fi
}

if ! have "$ASR_DIR"; then
  echo ">> downloading $ASR_DIR (~650 MB)"
  dl "$ASR_GH/$ASR_DIR.tar.bz2" "/tmp/$ASR_DIR.tar.bz2"
  tar -xjf "/tmp/$ASR_DIR.tar.bz2" -C models
  rm -f "/tmp/$ASR_DIR.tar.bz2"
else echo ">> $ASR_DIR already present, skipping"; fi

if ! have "$PUNCT_DIR"; then
  echo ">> downloading $PUNCT_DIR (~38 MB)"
  dl "$PUNCT_GH/$PUNCT_DIR.tar.bz2" "/tmp/$PUNCT_DIR.tar.bz2"
  tar -xjf "/tmp/$PUNCT_DIR.tar.bz2" -C models
  rm -f "/tmp/$PUNCT_DIR.tar.bz2"
else echo ">> $PUNCT_DIR already present, skipping"; fi

echo ">> models ready in ./models/"
ls -d models/*/ 2>/dev/null || echo "!! download failed — check the URL or grab the dirs manually from the catalog above"
