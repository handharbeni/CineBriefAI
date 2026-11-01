#!/usr/bin/env bash
# Generate a REAL test video: 3 distinct scenes (hard cuts) + tone audio. No mocks.
set -euo pipefail
OUT="${1:-data/sample.mp4}"
mkdir -p "$(dirname "$OUT")"
ffmpeg -y -v error \
  -f lavfi -t 4 -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -t 4 -i "smptebars=size=1280x720:rate=30" \
  -f lavfi -t 4 -i "mandelbrot=size=1280x720:rate=30" \
  -f lavfi -t 12 -i "sine=frequency=440:sample_rate=44100" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -map 3:a -c:v libx264 -preset veryfast -crf 23 -c:a aac -shortest -movflags +faststart "$OUT"
echo "wrote $OUT"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
