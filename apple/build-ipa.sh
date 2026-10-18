#!/usr/bin/env bash
# Builds an unsigned Tessera.ipa for the iPad. SideStore or AltStore signs it
# with your Apple ID when it installs it.

set -Eeuo pipefail

readonly APPLE_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly XCODE_DEVELOPER_DIRECTORY="/Applications/Xcode.app/Contents/Developer"

usage() {
  cat <<USAGE
Usage: bash $0 [--output PATH] [--help]

  --output PATH  where to write the .ipa (default: apple/build/Tessera.ipa)
  --help         show this help
USAGE
}

show_help=false
work_directory=""
output_path="${APPLE_DIRECTORY}/build/Tessera.ipa"

parse_arguments() {
  show_help=false
  while (($# > 0)); do
    case "$1" in
      --output | -o)
        if (($# < 2)) || [[ -z $2 ]]; then
          echo "error: $1 needs a path" >&2
          return 2
        fi
        output_path="$2"
        shift
        ;;
      --help | -h)
        show_help=true
        ;;
      *)
        echo "error: unknown option: $1" >&2
        usage >&2
        return 2
        ;;
    esac
    shift
  done
}

# xcodebuild fails when xcode-select still points at the Command Line Tools.
use_xcode_if_needed() {
  if [[ -n ${DEVELOPER_DIR:-} ]]; then
    return 0
  fi
  if [[ $(xcode-select -p 2>/dev/null) == */CommandLineTools* && -d ${XCODE_DEVELOPER_DIRECTORY} ]]; then
    export DEVELOPER_DIR="${XCODE_DEVELOPER_DIRECTORY}"
  fi
}

build_ipa() {
  local app_path
  work_directory="$(mktemp -d)"
  trap 'rm -rf "${work_directory}"' EXIT

  xcodebuild \
    -project "${APPLE_DIRECTORY}/Tessera.xcodeproj" \
    -scheme Tessera \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "${work_directory}/DerivedData" \
    -quiet \
    build \
    CODE_SIGNING_ALLOWED=NO

  app_path="${work_directory}/DerivedData/Build/Products/Release-iphoneos/Tessera.app"
  if [[ ! -d ${app_path} ]]; then
    echo "error: the build did not produce ${app_path}" >&2
    return 1
  fi

  # An .ipa is a zip of Payload/<name>.app.
  mkdir -p "${work_directory}/Payload"
  cp -R "${app_path}" "${work_directory}/Payload/"
  rm -f "${output_path}"
  (cd "${work_directory}" && zip -qry "${output_path}" Payload)

  local version
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app_path}/Info.plist")"
  echo "Built Tessera ${version}: ${output_path}"
}

if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

parse_arguments "$@" || exit $?
if ${show_help}; then
  usage
  exit 0
fi
# zip runs from the work directory, so the output path must be absolute.
mkdir -p "$(dirname "${output_path}")"
output_path="$(cd "$(dirname "${output_path}")" && pwd)/$(basename "${output_path}")"
use_xcode_if_needed
build_ipa
