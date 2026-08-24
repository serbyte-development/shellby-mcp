#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
peekaboo_root_input="${1:-${PEEKABOO_REPO:-"$repo_root/../Peekaboo-serbyte"}}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The vendored Universal 2 binary must be built on macOS." >&2
  exit 1
fi

for required_command in codesign git lipo node shasum stat swift; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if [[ ! -d "$peekaboo_root_input" ]]; then
  echo "Peekaboo repository not found: $peekaboo_root_input" >&2
  echo "Usage: $0 /absolute/path/to/Peekaboo" >&2
  exit 1
fi

peekaboo_root="$(cd -- "$peekaboo_root_input" && pwd -P)"
if [[ ! -f "$peekaboo_root/Apps/CLI/Package.swift" || ! -x "$peekaboo_root/scripts/build-swift-universal.sh" ]]; then
  echo "Not a Peekaboo source checkout: $peekaboo_root" >&2
  exit 1
fi

if [[ -n "$(git -C "$peekaboo_root" status --porcelain --untracked-files=no)" ]]; then
  echo "Peekaboo has tracked changes; commit them before producing a vendored binary." >&2
  exit 1
fi

source_commit="$(git -C "$peekaboo_root" rev-parse HEAD)"
source_repository="$(git -C "$peekaboo_root" remote get-url origin 2>/dev/null || printf 'unknown')"
version="$(node -p "require('$peekaboo_root/version.json').version")"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/shellby-peekaboo.XXXXXX")"
build_root="$temporary_root/Peekaboo"
temporary_binary=""
temporary_provenance=""

cleanup() {
  [[ -z "$temporary_binary" ]] || rm -f "$temporary_binary"
  [[ -z "$temporary_provenance" ]] || rm -f "$temporary_provenance"
  rm -rf "$temporary_root"
}
trap cleanup EXIT

git clone --local --no-checkout "$peekaboo_root" "$build_root"
git -C "$build_root" checkout --detach "$source_commit"
git -C "$build_root" submodule update --init --recursive
SIGN_IDENTITY="${SIGN_IDENTITY:--}" CODESIGN_TIMESTAMP="${CODESIGN_TIMESTAMP:-auto}" "$build_root/scripts/build-swift-universal.sh"

built_binary="$build_root/peekaboo"
if [[ ! -x "$built_binary" ]]; then
  echo "Peekaboo build did not produce $built_binary" >&2
  exit 1
fi

architectures="$(lipo -archs "$built_binary")"
if [[ "$architectures" != *"arm64"* || "$architectures" != *"x86_64"* ]]; then
  echo "Peekaboo binary is missing a required architecture: $architectures" >&2
  exit 1
fi
codesign --verify --strict "$built_binary"

size_bytes="$(stat -f '%z' "$built_binary")"
if (( size_bytes >= 100000000 )); then
  echo "Peekaboo binary exceeds GitHub's 100 MB file limit: $size_bytes bytes" >&2
  exit 1
fi

vendor_dir="$repo_root/vendor/peekaboo"
mkdir -p "$vendor_dir"
temporary_binary="$(mktemp "$vendor_dir/.peekaboo.XXXXXX")"
temporary_provenance="$(mktemp "$vendor_dir/.provenance.XXXXXX")"

cp "$built_binary" "$temporary_binary"
chmod 0755 "$temporary_binary"

for existing_library in "$vendor_dir"/libswiftCompatibility*.dylib; do
  [[ -e "$existing_library" ]] || continue
  rm -f -- "$existing_library"
done
for built_library in "$build_root"/libswiftCompatibility*.dylib; do
  [[ -e "$built_library" ]] || continue
  cp "$built_library" "$vendor_dir/"
  chmod 0755 "$vendor_dir/$(basename "$built_library")"
done

sha256="$(shasum -a 256 "$temporary_binary" | awk '{print $1}')"
swift_version="$(swift --version 2>&1 | head -n 1)"
signature="$(codesign -dv --verbose=2 "$temporary_binary" 2>&1 | awk -F= '/^Signature=/{print $2; exit}')"

node - "$temporary_provenance" "$source_repository" "$source_commit" "$version" "$sha256" "$size_bytes" "$swift_version" "$signature" <<'NODE'
const fs = require("node:fs")

const [output, sourceRepository, sourceCommit, version, sha256, sizeBytes, swift, signature] = process.argv.slice(2)
const provenance = {
  source_repository: sourceRepository,
  source_commit: sourceCommit,
  version,
  binary: "peekaboo",
  targets: ["arm64-apple-macos", "x86_64-apple-macos"],
  build_command: "scripts/build-swift-universal.sh",
  signing: signature || "unknown",
  sha256,
  size_bytes: Number(sizeBytes),
  swift,
}

fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`)
NODE

chmod 0644 "$temporary_provenance"
cp "$build_root/LICENSE" "$vendor_dir/LICENSE"
mv "$temporary_binary" "$vendor_dir/peekaboo"
mv "$temporary_provenance" "$vendor_dir/provenance.json"

echo "Vendored Peekaboo $version from $source_commit"
echo "Binary: $vendor_dir/peekaboo ($size_bytes bytes)"
echo "Architectures: $architectures"
echo "SHA-256: $sha256"
