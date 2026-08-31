#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPOSITORY="umpecca/tessera"
readonly SERVICE_USER="tessera"
readonly SERVICE_GROUP="tessera"
readonly INSTALL_PATH="/usr/local/bin/tessera"
readonly STATE_DIRECTORY="/var/lib/tessera"
readonly UNIT_PATH="/etc/systemd/system/tessera.service"

if [[ ${EUID} -ne 0 ]]; then
  echo "error: this installer must run as root (try: sudo $0)" >&2
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

for command in curl getent groupadd install mktemp mv systemctl useradd; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "error: required command not found: ${command}" >&2
    exit 1
  fi
done

case "$(uname -m)" in
  x86_64 | amd64)
    release_arch="amd64"
    ;;
  aarch64 | arm64)
    release_arch="arm64"
    ;;
  *)
    echo "error: unsupported CPU architecture: $(uname -m) (supported: amd64, arm64)" >&2
    exit 1
    ;;
esac

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

asset="tessera-linux-${release_arch}"
download_url="https://github.com/${REPOSITORY}/releases/latest/download/${asset}"
download_path="$(mktemp --tmpdir tessera-download.XXXXXXXXXX)"
install_staging_path="${INSTALL_PATH}.new"

cleanup() {
  rm -f "${download_path}" "${install_staging_path}"
}
trap cleanup EXIT

echo "Downloading the latest ${asset} release..."
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
  --output "${download_path}" "${download_url}"

if [[ ! -s ${download_path} ]]; then
  echo "error: downloaded release asset is empty" >&2
  exit 1
fi

if ! getent group "${SERVICE_GROUP}" >/dev/null; then
  groupadd --system "${SERVICE_GROUP}"
fi

if ! getent passwd "${SERVICE_USER}" >/dev/null; then
  useradd --system \
    --gid "${SERVICE_GROUP}" \
    --home-dir "${STATE_DIRECTORY}" \
    --shell /usr/sbin/nologin \
    "${SERVICE_USER}"
fi

install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${STATE_DIRECTORY}"
install -m 0755 -o root -g root "${download_path}" "${install_staging_path}"
mv -f "${install_staging_path}" "${INSTALL_PATH}"

cat >"${UNIT_PATH}" <<UNIT
[Unit]
Description=Tessera local-first workspace
Documentation=https://github.com/umpecca/tessera
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=tessera
Group=tessera
WorkingDirectory=/var/lib/tessera
ExecStart=/usr/local/bin/tessera -addr ${listen_address}:7331 -db /var/lib/tessera/tessera.sqlite3 -tray=false
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tessera

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
echo "View logs with: journalctl -u tessera.service -f"
