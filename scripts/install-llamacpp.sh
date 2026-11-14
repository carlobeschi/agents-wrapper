#!/bin/sh
# Installs llama.cpp (llama-server, llama-cvector-generator) for the night
# probe (llamacpp-probe.js). One command, run once:
#   sh ~/agents-wrapper/scripts/install-llamacpp.sh
# With Homebrew: brew install llama.cpp. Without: the official macOS release
# from github.com/ggml-org/llama.cpp, unpacked in ~/.local/llama.cpp, with
# small launchers in ~/.local/bin (already on night.sh's PATH). Nothing else
# on the Mac changes; delete ~/.local/llama.cpp to remove it.
set -e
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v llama-server >/dev/null 2>&1 && command -v llama-cvector-generator >/dev/null 2>&1; then
  echo "llama.cpp is already installed: $(command -v llama-server)"; exit 0
fi
if command -v brew >/dev/null 2>&1; then
  brew install llama.cpp
else
  dest="$HOME/.local/llama.cpp"
  mkdir -p "$dest" "$HOME/.local/bin"
  url=$(curl -fsSL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
    | grep -oE '"browser_download_url": *"[^"]*macos-arm64[^"]*\.(zip|tar\.gz)"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
  [ -n "$url" ] || { echo "Could not find the macOS release of llama.cpp"; exit 1; }
  echo "Downloading $url"
  curl -fL "$url" -o "$dest/release.archive"
  case "$url" in *.zip) (cd "$dest" && unzip -oq release.archive) ;; *) (cd "$dest" && tar xzf release.archive) ;; esac
  rm -f "$dest/release.archive"
  for b in llama-server llama-cvector-generator; do
    real=$(find "$dest" -type f -name "$b" | head -1)
    [ -n "$real" ] || { echo "$b not in the release"; exit 1; }
    chmod +x "$real"
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$real" > "$HOME/.local/bin/$b"
    chmod +x "$HOME/.local/bin/$b"
  done
fi
llama-server --version 2>&1 | head -2
echo "ok: llama.cpp installed"
