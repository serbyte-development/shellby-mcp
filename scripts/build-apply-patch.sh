#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
codex_root_input="${1:-${CODEX_REPO:-"$repo_root/../codex"}}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This vendored binary targets macOS arm64; build it on an Apple Silicon Mac." >&2
  exit 1
fi

for required_command in cargo git node rustc shasum strip; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if [[ ! -d "$codex_root_input" ]]; then
  echo "Codex repository not found: $codex_root_input" >&2
  echo "Usage: $0 /absolute/path/to/codex" >&2
  exit 1
fi

codex_root="$(cd -- "$codex_root_input" && pwd -P)"
source_manifest="$codex_root/codex-rs/Cargo.toml"

if [[ ! -f "$source_manifest" || ! -f "$codex_root/codex-rs/apply-patch/Cargo.toml" ]]; then
  echo "Not an OpenAI Codex checkout with the codex-apply-patch crate: $codex_root" >&2
  exit 1
fi

source_commit="$(git -C "$codex_root" rev-parse HEAD)"
source_repository="$(git -C "$codex_root" remote get-url origin 2>/dev/null || printf 'unknown')"
target_triple="aarch64-apple-darwin"
target_dir="$codex_root/codex-rs/target"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/codex-apply-patch.XXXXXX")"
source_worktree="$temporary_root/codex"
vendor_dir="$repo_root/vendor/apply-patch"
mkdir -p "$vendor_dir"
temporary_binary="$(mktemp "$vendor_dir/.apply_patch.XXXXXX")"
temporary_provenance="$(mktemp "$vendor_dir/.provenance.XXXXXX")"
worktree_added=false

cleanup() {
  rm -f "$temporary_binary" "$temporary_provenance"
  if [[ "$worktree_added" == true ]]; then
    git -C "$codex_root" worktree remove --force "$source_worktree" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

git -C "$codex_root" worktree add --detach "$source_worktree" "$source_commit"
worktree_added=true
manifest="$source_worktree/codex-rs/Cargo.toml"

CARGO_TARGET_DIR="$target_dir" cargo build \
  --manifest-path "$manifest" \
  --package codex-apply-patch \
  --bin apply_patch \
  --release

built_binary="$target_dir/release/apply_patch"
if [[ ! -x "$built_binary" ]]; then
  echo "Build completed without an executable at $built_binary" >&2
  exit 1
fi

cp "$built_binary" "$temporary_binary"
strip -x "$temporary_binary"
chmod 0755 "$temporary_binary"

sha256="$(shasum -a 256 "$temporary_binary" | awk '{print $1}')"
size_bytes="$(stat -f '%z' "$temporary_binary")"
rustc_version="$(rustc --version)"
cargo_version="$(cargo --version)"

node - \
  "$temporary_provenance" \
  "$source_repository" \
  "$source_commit" \
  "$target_triple" \
  "$sha256" \
  "$size_bytes" \
  "$rustc_version" \
  "$cargo_version" <<'NODE'
const fs = require("node:fs");

const [
  output,
  sourceRepository,
  sourceCommit,
  target,
  sha256,
  sizeBytes,
  rustc,
  cargo,
] = process.argv.slice(2);

const provenance = {
  source_repository: sourceRepository,
  source_commit: sourceCommit,
  crate: "codex-apply-patch",
  binary: "apply_patch",
  target,
  build_command:
    "cargo build --package codex-apply-patch --bin apply_patch --release",
  sha256,
  size_bytes: Number(sizeBytes),
  rustc,
  cargo,
};

fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`);
NODE

chmod 0644 "$temporary_provenance"
cp "$source_worktree/LICENSE" "$vendor_dir/LICENSE"
cp "$source_worktree/NOTICE" "$vendor_dir/NOTICE"
mv "$temporary_binary" "$vendor_dir/apply_patch"
mv "$temporary_provenance" "$vendor_dir/provenance.json"

echo "Vendored codex-apply-patch $source_commit"
echo "Binary: $vendor_dir/apply_patch ($size_bytes bytes)"
echo "SHA-256: $sha256"
