#!/usr/bin/env bash
# User-local fixes only: no sudo, nothing outside ~/.local.
# Safe to rerun: each step skips itself when its tool already resolves.
set -euo pipefail
BIN="$HOME/.local/bin"
OPT="$HOME/.local/opt"
mkdir -p "$BIN" "$OPT"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

have() { env -i HOME="$HOME" PATH="$BIN:/usr/bin:/bin" bash -c "command -v $1" >/dev/null 2>&1; }

link() { [ -e "$2" ] || ln -s "$1" "$2"; }

link "$HOME/.grok/bin/grok" "$BIN/grok"
for t in elan lean lake; do link "$HOME/.elan/bin/$t" "$BIN/$t"; done
link /usr/bin/python3 "$BIN/python"

if ! have uv; then
  curl -LsSf https://astral.sh/uv/0.9.7/install.sh | env UV_NO_MODIFY_PATH=1 sh
fi

if ! have rg; then
  v=14.1.1; f="ripgrep-$v-x86_64-unknown-linux-musl.tar.gz"
  curl -fsSLo "$tmp/$f" "https://github.com/BurntSushi/ripgrep/releases/download/$v/$f"
  curl -fsSLo "$tmp/$f.sha256" "https://github.com/BurntSushi/ripgrep/releases/download/$v/$f.sha256"
  (cd "$tmp" && sha256sum -c "$f.sha256")
  tar -xzf "$tmp/$f" -C "$OPT"
  ln -sf "$OPT/${f%.tar.gz}/rg" "$BIN/rg"
fi

if ! have hyperfine; then
  v=1.19.0; f="hyperfine-v$v-x86_64-unknown-linux-musl.tar.gz"
  curl -fsSLo "$tmp/$f" "https://github.com/sharkdp/hyperfine/releases/download/v$v/$f"
  tar -xzf "$tmp/$f" -C "$OPT"
  ln -sf "$OPT/${f%.tar.gz}/hyperfine" "$BIN/hyperfine"
fi

if ! have go; then
  v=1.23.4; f="go$v.linux-amd64.tar.gz"
  want=$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' \
    | python3 -c "import json,sys; print(next(x['sha256'] for r in json.load(sys.stdin) for x in r['files'] if x['filename']=='$f'))")
  curl -fsSLo "$tmp/$f" "https://go.dev/dl/$f"
  echo "$want  $tmp/$f" | sha256sum -c -
  rm -rf "$OPT/go" && tar -xzf "$tmp/$f" -C "$OPT"
  ln -sf "$OPT/go/bin/go" "$BIN/go"; ln -sf "$OPT/go/bin/gofmt" "$BIN/gofmt"
fi
