#!/usr/bin/env bash
# Re-runs the Paddle and Ovis comparison on the published line images.
# usage: rerun.sh <model folder> <output folder>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$1" "$2"
M="$(cd "$1" && pwd)"
OUT="$(cd "$2" && pwd)"

fetch() {
  [ -f "$M/$1" ] || curl -fsSL --retry 3 -o "$M/$1" "https://huggingface.co/$2"
  echo "$3  $M/$1" | shasum -a 256 -c -
}
PADDLE=PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/511b09642bb324401f15f97cc23bc67e8f0a291d
OVIS=michalland/OvisOCR3-GGUF/resolve/7be644a312005c3a55e2c826aee985a5c93d06b2
fetch paddle-model.gguf "$PADDLE/PaddleOCR-VL-1.6-GGUF.gguf" f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8
fetch paddle-mmproj.gguf "$PADDLE/PaddleOCR-VL-1.6-GGUF-mmproj.gguf" 204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a
fetch ovis-Q8_0.gguf "$OVIS/OvisOCR3-Q8_0.gguf" 11af29712f08d7f76e6ec06e25d368cc5e25259d51d9fe6cf5ddbb9f1b894ca6
fetch ovis-mmproj-F16.gguf "$OVIS/mmproj-OvisOCR3-F16.gguf" 698d199cf44ff10f99825bbd71ad9715e03a6cf7ad041c8ec1db979bfce905cd
fetch plain_ocr.txt ATH-MaaS/OvisOCR3/resolve/17f255e2c8ae6d18d5d5edb0a474bd4ed39aef90/prompts/plain_ocr.txt e037cf0013a757e19eae6d4d701f3b90848449fbebe44d1f8fa7d8ca4a5af9a7

SETS=(base real-names degraded)
for s in "${SETS[@]}"; do
  mkdir -p "$OUT/$s"
  ln -sfn "$ROOT/images/$s" "$OUT/$s/screens"
  ln -sfn "$ROOT/images/$s/strips" "$OUT/$s/strips"
done

run() {
  local name=$1 model=$2 mmproj=$3 prompt=$4 port=$5 pid s
  shift 5
  llama-server -m "$M/$model" --mmproj "$M/$mmproj" -lm none --cache-ram 0 --jinja -c 8192 --temp 0 -np 1 \
    "$@" --port "$port" --host 127.0.0.1 >"$OUT/$name-server.log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null' EXIT
  until curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null; do
    kill -0 "$pid"
    sleep 1
  done
  for s in "${SETS[@]}"; do
    python3 -I "$ROOT/scripts/bench.py" "$name" "$port" "$prompt" "$OUT/$s" | grep TOTAL | sed "s/^/$s /"
  done
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  trap - EXIT
}
run paddle paddle-model.gguf paddle-mmproj.gguf "OCR:" 18081
run ovis ovis-Q8_0.gguf ovis-mmproj-F16.gguf "$M/plain_ocr.txt" 18082 --chat-template-kwargs '{"enable_thinking": false}'
