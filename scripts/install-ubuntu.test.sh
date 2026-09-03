#!/usr/bin/env bash

set -Eeuo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-ubuntu.sh
source "${script_directory}/install-ubuntu.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

parse_arguments --with-lame
[[ ${install_lame} == "true" && ${show_help} == "false" ]] || fail "--with-lame was not parsed"

parse_arguments --without-lame
[[ ${install_lame} == "false" ]] || fail "--without-lame was not parsed"

parse_arguments --help
[[ ${show_help} == "true" ]] || fail "--help was not parsed"

if parse_arguments --with-lame --without-lame >/dev/null 2>&1; then
  fail "conflicting LAME options were accepted"
fi
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

install_lame=""
choose_lame_installation false >/dev/null
[[ ${install_lame} == "false" ]] || fail "non-interactive installation did not default to no"

install_lame=""
choose_lame_installation true >/dev/null <<<""
[[ ${install_lame} == "false" ]] || fail "interactive empty response did not default to no"

install_lame=""
choose_lame_installation true >/dev/null <<<"y"
[[ ${install_lame} == "true" ]] || fail "interactive yes response was not accepted"

test_directory="$(mktemp -d)"
test_download="${test_directory}/tessera-lame-linux-arm64"
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
  printf 'mock LAME binary' >"${output_path}"
}

download_release_asset "tessera-lame-linux-arm64" "${test_download}" >/dev/null
[[ -s ${test_download} ]] || fail "mock asset was not downloaded"
[[ ${requested_url} == "https://github.com/umpecca/tessera/releases/latest/download/tessera-lame-linux-arm64" ]] \
  || fail "release asset URL mismatch: ${requested_url}"

rm -f "${test_download}"
rmdir "${test_directory}"

echo "install-ubuntu tests passed"
