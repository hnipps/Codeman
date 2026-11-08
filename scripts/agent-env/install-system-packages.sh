#!/usr/bin/env bash
# Needs sudo, so an operator runs it. Covers the apt-only gaps check.sh reports.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y unzip fontconfig fonts-dejavu-core fonts-liberation python3-pip python3-venv python3-pil
