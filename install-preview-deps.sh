#!/usr/bin/env bash
set -euo pipefail
apt-get update
apt-get install -y poppler-utils
pdftoppm -v
printf '\nDependência do preview PNG instalada com sucesso.\n'
