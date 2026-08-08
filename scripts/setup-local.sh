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
RESET_DATABASE=false
ADMIN_CONNECTION_MODE=""
ADMIN_DATABASE_URL=""

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

for argument in "$@"; do
  case "$argument" in
    --reset-db)
      RESET_DATABASE=true
      ;;
    --help|-h)
      printf 'Usage: bash scripts/setup-local.sh [--reset-db]\n'
      printf '  --reset-db  Drop and recreate only the local database named by DATABASE_URL.\n'
      exit 0
      ;;
    *)
      die "Unknown option: $argument. Use --help for supported options."
      ;;
  esac
done

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
  if command -v psql >/dev/null 2>&1 && command -v pg_isready >/dev/null 2>&1; then
    return
  fi

  case "$(uname -s)" in
    Darwin)
      ensure_homebrew
      local installed_formula="$(brew list --formula 2>/dev/null | awk '/^postgresql(@[0-9]+)?$/ { print }' | tail -n 1)"
      if [ -n "$installed_formula" ]; then
        info "Linking installed PostgreSQL client ($installed_formula)"
        brew link --overwrite --force "$installed_formula" >/dev/null 2>&1 || true
      else
        info "Installing PostgreSQL with Homebrew"
        brew install postgresql
        brew link --overwrite --force postgresql >/dev/null 2>&1 || true
      fi
      ;;
    Linux)
      install_postgres_on_linux
      ;;
    *)
      die "PostgreSQL is required by DATABASE_URL. Install PostgreSQL and run this script again."
      ;;
  esac

  command -v psql >/dev/null 2>&1 || die "PostgreSQL installation did not provide the psql command."
  command -v pg_isready >/dev/null 2>&1 || die "PostgreSQL installation did not provide the pg_isready command."
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
  local cluster=""
  local cluster_version=""
  local cluster_name=""
  local service_units=""

  case "$(uname -s)" in
    Darwin)
      formula="$(postgres_formula)"
      [ -n "$formula" ] || die "PostgreSQL is installed but no Homebrew PostgreSQL service was found. Start PostgreSQL and run this script again."
      info "Starting PostgreSQL service ($formula)"
      brew services start "$formula" >/dev/null
      ;;
    Linux)
      if command -v pg_lsclusters >/dev/null 2>&1 && command -v pg_ctlcluster >/dev/null 2>&1; then
        cluster="$(pg_lsclusters --no-header 2>/dev/null | awk '$4 != "online" { print $1 ":" $2; exit }')"
        if [ -n "$cluster" ]; then
          cluster_version="${cluster%%:*}"
          cluster_name="${cluster#*:}"
          run_root pg_ctlcluster "$cluster_version" "$cluster_name" start 2>/dev/null || true
        fi
      fi
      if command -v systemctl >/dev/null 2>&1; then
        run_root systemctl start postgresql 2>/dev/null || true
        service_units="$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '$1 ~ /^postgresql/ { print $1 }')"
        for service_unit in $service_units; do
          run_root systemctl start "$service_unit" 2>/dev/null || true
        done
      elif command -v service >/dev/null 2>&1; then
        run_root service postgresql start 2>/dev/null || true
      fi
      ;;
  esac
}

ensure_postgres_server() {
  local maintenance_url="$1"
  local database_host="$2"
  local attempt=0

  if pg_isready -q -d "$maintenance_url" >/dev/null 2>&1; then
    info "PostgreSQL is available"
    return
  fi

  if ! is_local_host "$database_host"; then
    die "PostgreSQL at the DATABASE_URL host ($database_host) is not reachable. Check the network and credentials; a local service cannot fix a remote database connection."
  fi

  start_postgres
  for attempt in $(seq 1 30); do
    if pg_isready -q -d "$maintenance_url" >/dev/null 2>&1; then
      info "PostgreSQL is available"
      return
    fi
    sleep 1
  done

  die "PostgreSQL is installed but not reachable at the DATABASE_URL host. Check that the PostgreSQL 18 service is running and that the host/port in .env are correct."
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

run_admin_psql() {
  case "$ADMIN_CONNECTION_MODE" in
    url)
      psql -X "$ADMIN_DATABASE_URL" "$@"
      ;;
    postgres_role)
      run_root -u postgres psql -X "$@"
      ;;
    *)
      die "PostgreSQL administrator connection was not initialized."
      ;;
  esac
}

run_admin_sql() {
  local sql="$1"
  shift
  printf '%s\n' "$sql" | run_admin_psql "$@"
}

select_postgres_admin() {
  local configured_admin_url="$1"
  local stripped_admin_url="$2"
  local capability_query="SELECT rolsuper OR (rolcreatedb AND rolcreaterole) FROM pg_roles WHERE rolname = current_user;"

  if [ -n "$configured_admin_url" ] && psql -X "$configured_admin_url" -Atqc "$capability_query" 2>/dev/null | grep -qx 't'; then
    ADMIN_CONNECTION_MODE=url
    ADMIN_DATABASE_URL="$configured_admin_url"
    info "PostgreSQL administrator connection with database/role privileges is available"
    return
  fi

  if psql -X "$MAINTENANCE_DATABASE_URL" -Atqc "$capability_query" 2>/dev/null | grep -qx 't'; then
    ADMIN_CONNECTION_MODE=url
    ADMIN_DATABASE_URL="$MAINTENANCE_DATABASE_URL"
    info "PostgreSQL administrator connection with database/role privileges is available"
    return
  fi

  if psql -X "$stripped_admin_url" -Atqc "$capability_query" 2>/dev/null | grep -qx 't'; then
    ADMIN_CONNECTION_MODE=url
    ADMIN_DATABASE_URL="$stripped_admin_url"
    info "PostgreSQL administrator connection with database/role privileges is available"
    return
  fi

  if [ "$(uname -s)" = "Linux" ] && is_local_host "$DATABASE_HOST" && run_root -u postgres psql -X -d postgres -Atqc "$capability_query" 2>/dev/null | grep -qx 't'; then
    ADMIN_CONNECTION_MODE=postgres_role
    info "PostgreSQL administrator connection with database/role privileges is available through the local postgres role"
    return
  fi

  die "PostgreSQL is reachable, but the selected role lacks CREATEDB/CREATEROLE privileges. Add DATABASE_ADMIN_URL pointing to an administrator database such as postgres://postgres:<password>@localhost:5432/postgres, or grant the local role the required privileges, then rerun setup."
}

ensure_database_role() {
  local role_exists=""
  local role_sql=""

  [ -n "$DATABASE_USER" ] || return

  role_exists="$(run_admin_sql "SELECT 1 FROM pg_roles WHERE rolname = :'database_role';" -v database_role="$DATABASE_USER" -Atq | tr -d '[:space:]')"
  if [ "$role_exists" != "1" ]; then
    info "Creating PostgreSQL role from DATABASE_URL"
    role_sql="SELECT format('CREATE ROLE %I LOGIN%s', :'database_role', CASE WHEN :'database_password' = '' THEN '' ELSE format(' PASSWORD %L', :'database_password') END) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'database_role');
\\gexec"
    run_admin_sql "$role_sql" -v database_role="$DATABASE_USER" -v database_password="$DATABASE_PASSWORD" -Atq
  elif [ -n "$DATABASE_PASSWORD" ] && is_local_host "$DATABASE_HOST"; then
    role_sql="SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'database_role', :'database_password') WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'database_role');
\\gexec"
    run_admin_sql "$role_sql" -v database_role="$DATABASE_USER" -v database_password="$DATABASE_PASSWORD" -Atq
  else
    role_sql="SELECT format('ALTER ROLE %I LOGIN', :'database_role') WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'database_role');
\\gexec"
    run_admin_sql "$role_sql" -v database_role="$DATABASE_USER" -Atq
  fi
}

reset_database() {
  local terminate_sql=""
  local drop_sql=""

  [ "$DATABASE_NAME" != "postgres" ] || die "Refusing to reset the postgres maintenance database. Set DATABASE_URL to the application database."
  info "Resetting local PostgreSQL database $DATABASE_NAME"

  terminate_sql="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database_name' AND pid <> pg_backend_pid();"
  run_admin_sql "$terminate_sql" -v database_name="$DATABASE_NAME" -Atq >/dev/null

  drop_sql="SELECT format('DROP DATABASE IF EXISTS %I', :'database_name');
\\gexec"
  run_admin_sql "$drop_sql" -v database_name="$DATABASE_NAME" -Atq
}

ensure_database() {
  local database_url="$1"
  local database_name="$2"
  local maintenance_url="$3"
  local database_exists=""
  local create_sql=""
  local grant_sql=""

  if [ "$RESET_DATABASE" != true ] && psql -X "$database_url" -Atqc 'SELECT 1' >/dev/null 2>&1; then
    info "Configured PostgreSQL database is available"
    return
  fi

  select_postgres_admin "$DATABASE_ADMIN_URL_VALUE" "$STRIPPED_ADMIN_DATABASE_URL"
  ensure_database_role

  if [ "$RESET_DATABASE" = true ]; then
    if ! is_local_host "$DATABASE_HOST"; then
      die "--reset-db is allowed only when DATABASE_URL points to localhost."
    fi
    reset_database
  fi

  if psql -X "$database_url" -Atqc 'SELECT 1' >/dev/null 2>&1; then
    info "Configured PostgreSQL database is available"
    return
  fi

  info "Creating PostgreSQL database $database_name if it does not exist"
  database_exists="$(run_admin_sql "SELECT 1 FROM pg_database WHERE datname = :'database_name';" -v database_name="$database_name" -Atq | tr -d '[:space:]')"
  if [ "$database_exists" != "1" ]; then
    create_sql="SELECT format('CREATE DATABASE %I%s', :'database_name', CASE WHEN :'database_role' = '' THEN '' ELSE format(' OWNER %I', :'database_role') END);
\\gexec"
    run_admin_sql "$create_sql" -v database_name="$database_name" -v database_role="$DATABASE_USER" -Atq
  elif [ -n "$DATABASE_USER" ]; then
    grant_sql="SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'database_name', :'database_role');
\\gexec"
    run_admin_sql "$grant_sql" -v database_name="$database_name" -v database_role="$DATABASE_USER" -Atq
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

  die "Database migration failed. Review the migration error above; no database reset was attempted. If this is a disposable local database, rerun with: bash scripts/setup-local.sh --reset-db"
}

[ -f .env ] || die "Missing .env. Copy .env_example to .env and keep the environment values for this machine."

DATABASE_URL_VALUE="$(env_value DATABASE_URL)"
[ -n "$DATABASE_URL_VALUE" ] || die "DATABASE_URL is missing from .env."
DATABASE_ADMIN_URL_VALUE="$(env_value DATABASE_ADMIN_URL)"

ensure_git
ensure_node

DATABASE_NAME="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); const name = decodeURIComponent(u.pathname.replace(/^\/+/, "")); if (!name || name.includes("/")) process.exit(1); process.stdout.write(name);')" || die "DATABASE_URL must include a database name."
case "$DATABASE_NAME" in
  ''|[-]*|*[!A-Za-z0-9_-]*)
    die "DATABASE_URL contains an unsupported database name. Use letters, numbers, underscores, or hyphens."
    ;;
esac

DATABASE_HOST="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname);')"
DATABASE_USER="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.username ? decodeURIComponent(u.username) : "");')"
DATABASE_PASSWORD="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); process.stdout.write(u.password ? decodeURIComponent(u.password) : "");')"
MAINTENANCE_DATABASE_URL="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); u.pathname = "/postgres"; process.stdout.write(u.toString());')"
STRIPPED_ADMIN_DATABASE_URL="$(DATABASE_URL="$DATABASE_URL_VALUE" node -e 'const u = new URL(process.env.DATABASE_URL); u.username = ""; u.password = ""; u.pathname = "/postgres"; process.stdout.write(u.toString());')"

ensure_postgres_tools
ensure_postgres_server "$MAINTENANCE_DATABASE_URL" "$DATABASE_HOST"
ensure_database "$DATABASE_URL_VALUE" "$DATABASE_NAME" "$MAINTENANCE_DATABASE_URL"
ensure_redis
install_node_dependencies
run_database_migrations

printf '\nLocal setup is complete.\n'
printf 'Start the API and frontend with: npm run dev:all\n'
printf 'Then open: http://localhost:5173\n'
