#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPOSITORY="umpecca/tessera"
readonly INSTALL_PATH="/usr/local/bin/tessera"
readonly STATE_DIRECTORY="/var/lib/tessera"
readonly UNIT_PATH="/etc/systemd/system/tessera.service"

usage() {
  cat <<USAGE
Usage: sudo bash $0 [--with-lame | --without-lame]

  --with-lame     install the matching Tessera LAME MP3 encoder companion
  --without-lame  skip LAME installation without removing an existing copy
  --help           show this help
USAGE
}

install_lame=""
show_help=false

parse_arguments() {
  install_lame=""
  show_help=false
  while (($# > 0)); do
    case "$1" in
      --with-lame | --without-lame)
        local requested="false"
        [[ $1 == "--with-lame" ]] && requested="true"
        if [[ -n ${install_lame} && ${install_lame} != "${requested}" ]]; then
          echo "error: --with-lame and --without-lame cannot be used together" >&2
          usage >&2
          return 2
        fi
        install_lame="${requested}"
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

choose_lame_installation() {
  local interactive="$1"
  local response
  if [[ -n ${install_lame} ]]; then
    return
  fi
  if [[ ${interactive} != "true" ]]; then
    install_lame="false"
    echo "No interactive terminal detected; skipping the optional LAME encoder. Use --with-lame to install it."
    return
  fi
  while true; do
    if ! read -r -p "Install the optional LAME MP3 encoder companion? [y/N]: " response; then
      echo >&2
      echo "error: no LAME selection made" >&2
      return 1
    fi
    case "${response:-n}" in
      y | Y | yes | YES | Yes)
        install_lame="true"
        return
        ;;
      n | N | no | NO | No)
        install_lame="false"
        return
        ;;
      *)
        echo "Please enter y or n."
        ;;
    esac
  done
}

release_architecture() {
  case "$1" in
    x86_64 | amd64)
      echo "amd64"
      ;;
    aarch64 | arm64)
      echo "arm64"
      ;;
    *)
      echo "error: unsupported CPU architecture: $1 (supported: amd64, arm64)" >&2
      return 1
      ;;
  esac
}

download_release_asset() {
  local asset_name="$1"
  local output_path="$2"
  local download_url="https://github.com/${REPOSITORY}/releases/latest/download/${asset_name}"
  echo "Downloading the latest ${asset_name} release..."
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    --output "${output_path}" "${download_url}"
  if [[ ! -s ${output_path} ]]; then
    echo "error: downloaded release asset is empty: ${asset_name}" >&2
    return 1
  fi
}

# Sourcing exposes the pure argument, prompt, and architecture helpers to the
# lightweight installer tests without performing privileged installation.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

parse_arguments "$@" || exit $?
if ${show_help}; then
  usage
  exit 0
fi

if [[ ${EUID} -ne 0 ]]; then
  echo "error: this installer must run as root (try: sudo $0)" >&2
  exit 1
fi

service_user="${SUDO_USER:-}"
if [[ -z ${service_user} || ${service_user} == "root" ]]; then
  echo "error: run this installer from a non-root account with sudo (try: sudo bash $0)" >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "error: cannot identify this operating system; Ubuntu is required" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ ${ID:-} != "ubuntu" ]]; then
  echo "error: this installer supports Ubuntu only (detected: ${PRETTY_NAME:-unknown})" >&2
  exit 1
fi

for command in chown curl getent id install mktemp mv systemctl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "error: required command not found: ${command}" >&2
    exit 1
  fi
done

if ! passwd_entry="$(getent passwd "${service_user}")"; then
  echo "error: invoking user does not exist: ${service_user}" >&2
  exit 1
fi

service_group="$(id -gn "${service_user}")"
IFS=: read -r _ _ _ _ _ service_home _ <<<"${passwd_entry}"
if [[ ${service_home} != /* ]]; then
  echo "error: invoking user has no valid home directory: ${service_user}" >&2
  exit 1
fi
if [[ ! -d ${service_home} ]]; then
  install -d -m 0750 -o "${service_user}" -g "${service_group}" "${service_home}"
fi

release_arch="$(release_architecture "$(uname -m)")"

listen_address="127.0.0.1"
if [[ -t 0 ]]; then
  while true; do
    if ! read -r -p "Listen address (127.0.0.1 or 0.0.0.0) [127.0.0.1]: " response; then
      echo >&2
      echo "error: no listen address selected" >&2
      exit 1
    fi
    case "${response:-127.0.0.1}" in
      127.0.0.1 | 0.0.0.0)
        listen_address="${response:-127.0.0.1}"
        break
        ;;
      *)
        echo "Please enter 127.0.0.1 or 0.0.0.0."
        ;;
    esac
  done
else
  echo "No interactive terminal detected; using the safe default listen address 127.0.0.1."
fi

if [[ -t 0 ]]; then
  choose_lame_installation true
else
  choose_lame_installation false
fi

asset="tessera-linux-${release_arch}"
download_directory="$(mktemp -d --tmpdir tessera-download.XXXXXXXXXX)"
download_path="${download_directory}/${asset}"
install_staging_path="${INSTALL_PATH}.new"
lame_asset="tessera-lame-linux-${release_arch}"
lame_download_path="${download_directory}/${lame_asset}"
lame_install_path="/usr/local/bin/${lame_asset}"
lame_staging_path="${lame_install_path}.new"

cleanup() {
  rm -f "${download_path}" "${lame_download_path}" "${install_staging_path}" "${lame_staging_path}"
  rmdir "${download_directory}" 2>/dev/null || true
}
trap cleanup EXIT

download_release_asset "${asset}" "${download_path}"
if [[ ${install_lame} == "true" ]]; then
  download_release_asset "${lame_asset}" "${lame_download_path}"
fi

install -d -m 0750 -o "${service_user}" -g "${service_group}" "${STATE_DIRECTORY}"
chown -R "${service_user}:${service_group}" "${STATE_DIRECTORY}"
install -m 0755 -o root -g root "${download_path}" "${install_staging_path}"
if [[ ${install_lame} == "true" ]]; then
  install -m 0755 -o root -g root "${lame_download_path}" "${lame_staging_path}"
  mv -f "${lame_staging_path}" "${lame_install_path}"
fi
mv -f "${install_staging_path}" "${INSTALL_PATH}"

cat >"${UNIT_PATH}" <<UNIT
[Unit]
Description=Tessera local-first workspace
Documentation=https://github.com/umpecca/tessera
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${service_user}
Group=${service_group}
WorkingDirectory=${service_home}
Environment=HOME=${service_home}
Environment=TESSERA_SYSTEMD_SERVICE=tessera.service
ExecStart=/usr/local/bin/tessera -addr ${listen_address}:7331 -db /var/lib/tessera/tessera.sqlite3 -tray=false
Restart=on-failure
RestartSec=5s
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

chmod 0644 "${UNIT_PATH}"
systemctl daemon-reload
systemctl enable tessera.service
systemctl restart tessera.service

if ! systemctl is-active --quiet tessera.service; then
  echo "error: Tessera did not start; inspect logs with: journalctl -u tessera.service" >&2
  exit 1
fi

if [[ ${listen_address} == "0.0.0.0" ]]; then
  echo "Tessera is installed and listening on all interfaces at port 7331."
  echo "Connect using this Ubuntu host's IP address; ensure firewall access is appropriately restricted."
else
  echo "Tessera is installed and running at http://127.0.0.1:7331"
fi
echo "The service is running as ${service_user} with home directory ${service_home}."
if [[ ${install_lame} == "true" ]]; then
  echo "Installed the optional LAME MP3 encoder at ${lame_install_path}."
  echo "Terminal audio capture still requires the separate tessera-audio-capture helper."
else
  echo "The optional LAME MP3 encoder was not installed."
fi
echo "View logs with: journalctl -u tessera.service -f"
