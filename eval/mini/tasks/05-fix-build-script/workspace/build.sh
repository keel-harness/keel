#!/usr/bin/env bash
set -euo pipefail

mkdir -p dist
node build/compile.js > dist/out.txt
echo "build ok"
