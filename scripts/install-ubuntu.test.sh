#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-ubuntu.sh
source "${script_directory}/install-ubuntu.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

parse_arguments --help
[[ ${show_help} == "true" ]] || fail "--help was not parsed"

parse_arguments
[[ ${show_help} == "false" ]] || fail "default installation retained the help flag"

for retired_option in --with-lame --without-lame; do
  if parse_arguments "${retired_option}" >/dev/null 2>&1; then
    fail "a retired option was accepted: ${retired_option}"
  fi
done
if parse_arguments --unknown >/dev/null 2>&1; then
  fail "an unknown option was accepted"
fi

[[ $(release_architecture x86_64) == "amd64" ]] || fail "x86_64 architecture mismatch"
[[ $(release_architecture amd64) == "amd64" ]] || fail "amd64 architecture mismatch"
[[ $(release_architecture aarch64) == "arm64" ]] || fail "aarch64 architecture mismatch"
[[ $(release_architecture arm64) == "arm64" ]] || fail "arm64 architecture mismatch"
if release_architecture sparc >/dev/null 2>&1; then
  fail "an unsupported architecture was accepted"
fi

test_directory="$(mktemp -d)"
test_download="${test_directory}/tessera-linux-arm64"
requested_url=""
curl() {
  local output_path=""
  while (($# > 0)); do
    if [[ $1 == "--output" ]]; then
      output_path="$2"
      shift 2
      continue
    fi
    requested_url="$1"
    shift
  done
  printf 'mock Tessera binary' >"${output_path}"
}

download_release_asset "tessera-linux-arm64" "${test_download}" >/dev/null
[[ -s ${test_download} ]] || fail "mock asset was not downloaded"
[[ ${requested_url} == "https://github.com/umpecca/tessera/releases/latest/download/tessera-linux-arm64" ]] \
  || fail "release asset URL mismatch: ${requested_url}"

rm -f "${test_download}"
rmdir "${test_directory}"

echo "install-ubuntu tests passed"
