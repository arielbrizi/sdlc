#!/usr/bin/env bash
# Levanta el studio contra el repo que le pases (o el cwd).
set -euo pipefail
cd "$(dirname "$0")/.."
exec node studio/server.mjs "$@"
