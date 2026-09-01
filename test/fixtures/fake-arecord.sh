#!/bin/sh

printf '%s\n' "$@" > "$0.args"
if [ -f "$0.fail" ]; then
  exit 9
fi
printf '\000\100\000\300'
trap 'exit 0' TERM
while :; do sleep 0.05; done
