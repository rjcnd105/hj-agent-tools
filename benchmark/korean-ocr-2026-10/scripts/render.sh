#!/usr/bin/env bash
# Rebuilds every published test image from the generators in this folder.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../images/{base,real-names,degraded,screening}
OUT="$(cd ../images && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

python3 gen_screens.py "$OUT/base"
python3 gen_screens.py "$OUT/real-names" real

for f in "$OUT"/real-names/*.png; do
  sips --resampleWidth 720 -s format jpeg -s formatOptions 60 "$f" \
    --out "$OUT/degraded/$(basename "$f" .png).jpg" >/dev/null
done
cp "$OUT"/real-names/{truth,titles}.json "$OUT/degraded/"

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=3 \
  --window-size=393,852 --screenshot="$OUT/screening/bank-a.png" "file://$PWD/bank-a.html" >/dev/null 2>&1

rm -f "$OUT"/base/*.html "$OUT"/real-names/*.html
