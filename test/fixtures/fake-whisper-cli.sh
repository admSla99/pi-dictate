#!/bin/sh

model=$2
printf '%s\n' "$@" > "$model.args"

case "$(cat "$model")" in
  abort)
    trap 'printf TERM > "$model.signal"; exit 0' TERM
    while :; do sleep 1; done
    ;;
  fail)
    i=0
    while [ "$i" -lt 100 ]; do
      printf 'fake whisper failure ' >&2
      i=$((i + 1))
    done
    exit 7
    ;;
  *)
    printf '[00:00:00.000 --> 00:00:05.000]   Ahoj   svet.\n'
    ;;
esac
