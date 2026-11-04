#!/usr/bin/env bash
# Rebuilds the audio and caption inputs from data/clips.csv. Run from an empty working folder.
# usage: download.sh <path to clips.csv>
set -euo pipefail
mkdir -p audio subs2 refs
tail -n +2 "$1" | while IFS=, read -r id category channel start end duration snr url; do
  uvx yt-dlp --no-warnings --no-playlist --sleep-requests 2 -f bestaudio \
    --download-sections "*$start-$end" -x --audio-format mp3 \
    --postprocessor-args "ffmpeg:-ar 16000 -ac 1 -b:a 64k" \
    -o "audio/$id.%(ext)s" "$url"
  uvx yt-dlp --skip-download --no-warnings --sleep-requests 2 \
    --write-subs --sub-langs ko --sub-format json3 --write-info-json \
    -o "subs2/$id.%(ext)s" "$url"
  sleep 12
done
