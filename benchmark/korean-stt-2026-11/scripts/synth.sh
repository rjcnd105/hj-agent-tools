#!/bin/bash
set -e
mk(){ ffmpeg -v error -y "$@"; }
args=(); fl=""; k=0
for o in q1v1_btl19w TNYIXKQy1FU RkyJGjwzSEA 0lCBzZBxKUQ nP5UJ5aVy7c YSwWF13jCko; do args+=(-i "audio/$o.mp3"); fl="${fl}[${k}:a]areverse,atrim=0:300[a${k}];"; k=$((k+1)); done
mk "${args[@]}" -filter_complex "${fl}[a0][a1][a2][a3][a4][a5]amix=inputs=6:normalize=0,alimiter[o]" -map "[o]" -ar 16000 -ac 1 synth/babble.wav
mean(){ ffmpeg -hide_banner -i "$1" -af volumedetect -f null - 2>&1 | sed -n 's/.*mean_volume: \(-*[0-9.]*\) dB/\1/p'; }
Bm=$(mean synth/babble.wav)
for id in QndOyQtTHUQ MHI2bTsLj90; do
  M=$(mean "audio/$id.mp3"); g5=$(python3 -I -c "print(round($M-5-($Bm),2))")
  mk -i "audio/$id.mp3" -i synth/babble.wav -filter_complex "[1:a]volume=${g5}dB[n];[0:a][n]amix=inputs=2:normalize=0:duration=first[o]" -map "[o]" -ar 16000 -ac 1 -b:a 64k "synth/${id}_crowd5db.mp3"
  mk -f lavfi -i "anoisesrc=color=pink:amplitude=0.02:r=16000:d=320" -i "audio/$id.mp3" -filter_complex "[1:a]aecho=0.8:0.7:60|120|200:0.5|0.35|0.25,highpass=f=200,lowpass=f=3400,volume=-20dB[s];[0:a]volume=-6dB[n];[s][n]amix=inputs=2:normalize=0:duration=shortest[o]" -map "[o]" -ar 16000 -ac 1 -b:a 64k "synth/${id}_farmic.mp3"
done
rm -f synth/babble.wav
