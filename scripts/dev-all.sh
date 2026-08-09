#!/usr/bin/env bash

set -u

if [ ! -f ".env" ]; then
  echo "Missing .env in $(pwd). Copy .env_example to .env and set your local values first." >&2
  exit 1
fi

server_pid=""
client_pid=""

env_value() {
  awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1); exit }' .env
}

detect_lan_ip() {
  node -e '
    const os = require("node:os");
    const interfaces = os.networkInterfaces();
    const preferred = ["en0", "en1", "wlan0", "eth0"];
    const candidates = Object.entries(interfaces)
      .flatMap(([name, entries]) => (entries ?? []).map((entry) => ({ name, entry })))
      .filter(({ entry }) => entry.family === "IPv4" && !entry.internal);
    const selected = preferred
      .map((name) => candidates.find((candidate) => candidate.name === name))
      .find(Boolean) ?? candidates[0];
    process.stdout.write(selected?.entry.address ?? "");
  '
}

api_port="$(env_value PORT)"
api_port="${api_port:-5000}"
frontend_port="$(env_value DEV_SERVER_PORT)"
frontend_port="${frontend_port:-5173}"

# The dev server binds to all interfaces, but the URL shown to users must use
# the host's current LAN address so phones, other laptops, and the Android app
# can reach it. DEV_ALL_HOST is an escape hatch for VPNs or multi-interface
# machines where the first detected address is not the desired one.
configured_host="${DEV_ALL_HOST:-}"
if [ -n "${configured_host}" ] && [ "${configured_host}" != "0.0.0.0" ] && [ "${configured_host}" != "localhost" ]; then
  lan_ip="${configured_host}"
else
  lan_ip="$(detect_lan_ip)"
fi
lan_ip="${lan_ip:-127.0.0.1}"

frontend_url="http://${lan_ip}:${frontend_port}"
api_url="http://${lan_ip}:${api_port}"

# Keep browser requests same-origin while making the Vite proxy target local.
# Explicit origins also keep the flow working when STRICT_CORS=true is used.
export DEV_SERVER_BIND="${DEV_SERVER_BIND:-0.0.0.0}"
export DEV_SERVER_HOST="${lan_ip}"
export DEV_SERVER_HMR_HOST="${lan_ip}"
export HOST="0.0.0.0"
export FRONTEND_URL="${frontend_url}"
export APP_BASE_URL="${api_url}"
export API_PROXY_TARGET="http://127.0.0.1:${api_port}"
export VITE_API_SAME_ORIGIN="true"
export VITE_API_URL="${frontend_url}"
export ALLOWED_ORIGINS="${frontend_url},http://localhost:${frontend_port},http://127.0.0.1:${frontend_port},${api_url},http://localhost:${api_port},http://127.0.0.1:${api_port}"

cleanup() {
  trap - INT TERM EXIT

  if [ -n "${server_pid}" ] && kill -0 "${server_pid}" 2>/dev/null; then
    kill "${server_pid}" 2>/dev/null || true
  fi
  if [ -n "${client_pid}" ] && kill -0 "${client_pid}" 2>/dev/null; then
    kill "${client_pid}" 2>/dev/null || true
  fi

  [ -n "${server_pid}" ] && wait "${server_pid}" 2>/dev/null || true
  [ -n "${client_pid}" ] && wait "${client_pid}" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

echo "Starting API on ${api_url} and frontend on ${frontend_url}"
echo "Frontend: ${frontend_url}"
echo "Admin:    ${frontend_url}/admin/login"
echo "API:      ${api_url}/api/health"
echo "Android:  ${api_url} (physical device; emulator uses http://10.0.2.2:${api_port})"
echo "Local:    http://localhost:${frontend_port} (admin at /admin/login)"
echo "Child processes load the existing .env, config/local-auth.json, and local database/session settings."

npm run dev:server &
server_pid=$!

npm run dev:client &
client_pid=$!

while true; do
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    echo "API process stopped; stopping frontend." >&2
    exit 1
  fi

  if ! kill -0 "${client_pid}" 2>/dev/null; then
    echo "Frontend process stopped; stopping API." >&2
    exit 1
  fi

  sleep 1
done
