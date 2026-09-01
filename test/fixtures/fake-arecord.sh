#!/bin/sh

printf '%s\n' "$@" > "$0.args"
if [ -f "$0.fail" ]; then
  exit 9
fi
printf '\000\100\000\300'
# arecord handles SIGTERM and commonly reports the interrupted capture as exit 1.
trap 'exit 1' TERM
while :; do sleep 0.05; done
