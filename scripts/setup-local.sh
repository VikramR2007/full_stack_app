#!/usr/bin/env bash

# Bootstrap a local Doorstep development machine.
#
# This script intentionally does not source .env. Values such as cron expressions
# contain shell metacharacters, and dotenv files are not shell scripts.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

MIN_NODE_MAJOR=20
APT_UPDATED=0

die() {
  printf 'Setup failed: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '[setup] %s\n' "$1"
}

warn() {
  printf '[setup] warning: %s\n' "$1" >&2
}

env_value() {
  local key="$1"

  awk -F= -v wanted_key="$key" '
    $0 !~ /^[[:space:]]*#/ && $1 == wanted_key {
      value = substr($0, index($0, "=") + 1)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' .env
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_local_host() {
  case "$1" in
    ''|localhost|127.*|::1|\[::1\])
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

ensure_homebrew() {
  if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew is required on macOS to install missing packages. Install it from https://brew.sh and run this script again."
  fi
}

apt_update_once() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    info "Updating apt package metadata"
    run_root apt-get update
    APT_UPDATED=1
  fi
}

install_node_on_linux() {
  command -v apt-get >/dev/null 2>&1 || die "Node.js $MIN_NODE_MAJOR+ is missing and no supported Linux package manager was found."
  command -v curl >/dev/null 2>&1 || {
    apt_update_once
    run_root apt-get install -y curl ca-certificates
  }

  info "Installing Node.js $MIN_NODE_MAJOR.x"
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | run_root bash -
  run_root apt-get install -y nodejs
}

ensure_node() {
  local major=""

  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  fi

  if [ -n "$major" ] && [ "$major" -ge "$MIN_NODE_MAJOR" ] && command -v npm >/dev/null 2>&1; then
    if [ "$major" -ne "$MIN_NODE_MAJOR" ]; then
      warn "Node.js $major detected; the project targets Node.js $MIN_NODE_MAJOR.x, but this version is supported for local setup."
    else
      info "Node.js $major and npm are already installed"
    fi
    return
  fi

  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      info "Installing Node.js $MIN_NODE_MAJOR.x with Homebrew"
      brew install "node@${MIN_NODE_MAJOR}"
      brew link --overwrite --force "node@${MIN_NODE_MAJOR}" >/dev/null 2>&1 || true
      ;;
    Linux)
      install_node_on_linux
      ;;
    *)
      die "Node.js $MIN_NODE_MAJOR+ is required. Install it and run this script again."
      ;;
  esac

  command -v node >/dev/null 2>&1 || die "Node.js installation did not provide the node command."
  command -v npm >/dev/null 2>&1 || die "Node.js installation did not provide the npm command."
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi

  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      info "Installing git with Homebrew"
      brew install git
      ;;
    Linux)
      command -v apt-get >/dev/null 2>&1 || die "git is required to manage this checkout."
      apt_update_once
      run_root apt-get install -y git
      ;;
    *)
      die "git is required to manage this checkout."
      ;;
  esac
}

install_postgres_on_linux() {
  command -v apt-get >/dev/null 2>&1 || die "PostgreSQL is missing. Install PostgreSQL and run this script again."
  apt_update_once
  info "Installing PostgreSQL client and server"
  run_root apt-get install -y postgresql postgresql-client
}

ensure_postgres_tools() {
  if command -v psql >/dev/null 2>&1; then
    return
  fi

  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      info "Installing PostgreSQL 16 with Homebrew"
      brew install postgresql@16
      brew link --overwrite --force postgresql@16 >/dev/null 2>&1 || true
      ;;
    Linux)
      install_postgres_on_linux
      ;;
    *)
      die "PostgreSQL is required by DATABASE_URL. Install PostgreSQL and run this script again."
      ;;
  esac

  command -v psql >/dev/null 2>&1 || die "PostgreSQL installation did not provide the psql command."
}

postgres_formula() {
  local started_formula=""

  if ! command -v brew >/dev/null 2>&1; then
    return
  fi

  started_formula="$(brew services list 2>/dev/null | awk '$1 ~ /^postgresql(@[0-9]+)?$/ && $2 == "started" { print $1; exit }')"
  if [ -n "$started_formula" ]; then
    printf '%s' "$started_formula"
    return
  fi

  brew list --formula 2>/dev/null | awk '/^postgresql(@[0-9]+)?$/ { print }' | tail -n 1
}

start_postgres() {
  local formula=""

  case "$(uname -s)" in
    Darwin)
      formula="$(postgres_formula)"
      [ -n "$formula" ] || die "PostgreSQL is installed but no Homebrew PostgreSQL service was found. Start PostgreSQL and run this script again."
      info "Starting PostgreSQL service ($formula)"
      brew services start "$formula" >/dev/null
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        run_root systemctl start postgresql 2>/dev/null || run_root systemctl start postgresql@16 2>/dev/null || true
      elif command -v service >/dev/null 2>&1; then
        run_root service postgresql start 2>/dev/null || true
      fi
      ;;
  esac
}

ensure_postgres_server() {
  local maintenance_url="$1"
  local database_host="$2"

  if psql -X "$maintenance_url" -Atqc 'SELECT 1' >/dev/null 2>&1; then
    info "PostgreSQL is available"
    return
  fi

  if ! is_local_host "$database_host"; then
    die "PostgreSQL at the DATABASE_URL host ($database_host) is not reachable. Check the network and credentials; a local service cannot fix a remote database connection."
  fi

  start_postgres
  sleep 2
  psql -X "$maintenance_url" -Atqc 'SELECT 1' >/dev/null 2>&1 || die "PostgreSQL is installed but not reachable using DATABASE_URL. Check the host, port, user, and password in .env."
  info "PostgreSQL is available"
}

install_redis_on_linux() {
  command -v apt-get >/dev/null 2>&1 || die "Redis is missing. Install Redis or set DISABLE_REDIS=true in .env."
  apt_update_once
  info "Installing Redis"
  run_root apt-get install -y redis-server
}

ensure_redis() {
  local disabled="$(lowercase "$(env_value DISABLE_REDIS)")"
  local redis_url="$(env_value REDIS_URL)"
  local redis_host=""

  case "$disabled" in
    true|1|yes|on)
      info "Redis is disabled by DISABLE_REDIS"
      return
      ;;
  esac

  [ -n "$redis_url" ] || die "REDIS_URL is required unless DISABLE_REDIS=true is set in .env."

  redis_host="$(REDIS_URL="$redis_url" node -e 'const u = new URL(process.env.REDIS_URL); process.stdout.write(u.hostname);')"

  if command -v redis-cli >/dev/null 2>&1 && redis-cli -u "$redis_url" ping 2>/dev/null | grep -q 'PONG'; then
    info "Redis is available"
    return
  fi

  if ! command -v redis-cli >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin)
        ensure_homebrew
        info "Installing Redis with Homebrew"
        brew install redis
        ;;
      Linux)
        install_redis_on_linux
        ;;
      *)
      die "Redis is required by REDIS_URL. Install Redis or set DISABLE_REDIS=true in .env."
        ;;
    esac
  fi

  if ! is_local_host "$redis_host"; then
    redis-cli -u "$redis_url" ping 2>/dev/null | grep -q 'PONG' || die "Redis at the REDIS_URL host ($redis_host) is not reachable. Check the network and credentials; a local service cannot fix a remote Redis connection."
    info "Redis is available"
    return
  fi

  case "$(uname -s)" in
    Darwin)
      info "Starting Redis service"
      brew services start redis >/dev/null 2>&1 || true
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        run_root systemctl enable --now redis-server 2>/dev/null || run_root systemctl enable --now redis 2>/dev/null || true
      elif command -v service >/dev/null 2>&1; then
        run_root service redis-server start 2>/dev/null || run_root service redis start 2>/dev/null || true
      elif command -v redis-server >/dev/null 2>&1; then
        redis-server --daemonize yes
      fi
      ;;
  esac

  sleep 1
  redis-cli -u "$redis_url" ping 2>/dev/null | grep -q 'PONG' || die "Redis is installed but not reachable using REDIS_URL. Check the URL in .env."
  info "Redis is available"
}

ensure_database() {
  local database_url="$1"
  local database_name="$2"
  local maintenance_url="$3"
  local database_exists=""

  if psql -X "$database_url" -Atqc 'SELECT 1' >/dev/null 2>&1; then
    info "Configured PostgreSQL database is available"
    return
  fi

  info "Creating PostgreSQL database $database_name if it does not exist"
  database_exists="$(psql -X "$maintenance_url" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$database_name'" | tr -d '[:space:]')"
  if [ "$database_exists" != "1" ]; then
    psql -X "$maintenance_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database_name\";"
  fi

  psql -X "$database_url" -Atqc 'SELECT 1' >/dev/null 2>&1 || die "The PostgreSQL database was found/created, but DATABASE_URL still cannot connect to it."
  info "Configured PostgreSQL database is available"
}

install_node_dependencies() {
  if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
    info "npm dependencies are already installed"
    return
  fi

  info "Installing npm dependencies"
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
}

run_database_migrations() {
  if npm run db:migrate; then
    info "Database migrations are up to date"
    return
  fi

  local migration_table_exists=""
  local existing_tables=""
  migration_table_exists="$(psql -X "$DATABASE_URL_VALUE" -Atqc "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL" | tr -d '[:space:]')"
  existing_tables="$(psql -X "$DATABASE_URL_VALUE" -Atqc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users', 'services', 'products')" | tr -d '[:space:]')"

  if [ "$migration_table_exists" = "f" ] && [ "${existing_tables:-0}" -gt 0 ]; then
    warn "Existing application tables were found without migration history; attempting a safe migration-history baseline."
    npm run db:migrate:baseline
    npm run db:migrate
    info "Database migrations are up to date"
    return
  fi

  die "Database migration failed. Review the migration error above; no database reset was attempted."
}

[ -f .env ] || die "Missing .env. Copy .env_example to .env and keep the environment values for this machine."

DATABASE_URL_VALUE="$(env_value DATABASE_URL)"
[ -n "$DATABASE_URL_VALUE" ] || die "DATABASE_URL is missing from .env."

ensure_git
ensure_node

DATABASE_NAME="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); const name = decodeURIComponent(u.pathname.replace(/^\/+/, "")); if (!name || name.includes("/")) process.exit(1); process.stdout.write(name);')" || die "DATABASE_URL must include a database name."
case "$DATABASE_NAME" in
  ''|[-]*|*[!A-Za-z0-9_-]*)
    die "DATABASE_URL contains an unsupported database name. Use letters, numbers, underscores, or hyphens."
    ;;
esac

DATABASE_HOST="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname);')"
MAINTENANCE_DATABASE_URL="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); u.pathname = "/postgres"; process.stdout.write(u.toString());')"

ensure_postgres_tools
ensure_postgres_server "$MAINTENANCE_DATABASE_URL" "$DATABASE_HOST"
ensure_database "$DATABASE_URL_VALUE" "$DATABASE_NAME" "$MAINTENANCE_DATABASE_URL"
ensure_redis
install_node_dependencies
run_database_migrations

printf '\nLocal setup is complete.\n'
printf 'Start the API and frontend with: npm run dev:all\n'
printf 'Then open: http://localhost:5173\n'
