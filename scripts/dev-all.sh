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

api_port="$(env_value PORT)"
api_port="${api_port:-5000}"
frontend_port="$(env_value DEV_SERVER_PORT)"
frontend_port="${frontend_port:-5173}"

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

echo "Starting API on http://localhost:${api_port} and frontend on http://localhost:${frontend_port}"
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
