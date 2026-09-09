#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "task-handoff" ] && { [ "${2:-}" = "web" ] || [ "$#" -eq 1 ]; }; then
  echo "No controlled-instance runtime is active; waiting for node-agent bootstrap."
  trap 'exit 0' TERM INT
  while true; do
    sleep 3600 &
    wait "$!"
  done
fi

exec "$@"
