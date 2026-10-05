#!/usr/bin/env bash
# Provisions the least-privilege query user for txt2sql.
#
# docker-compose.yml mounts this directory read-only at
# /docker-entrypoint-initdb.d. The official mariadb image runs these files
# exactly once, when the data volume is first initialized (an existing volume is
# never touched again; `docker compose down -v` resets it). It SOURCES
# non-executable *.sh files, which gives this script the entrypoint's helpers
# (docker_process_sql talks to the init-only server over its unix socket as
# root). If the file is executed instead (exec bit set), small fallbacks below
# provide the same helpers.
#
# The query user gets SELECT on databases matching the escaped pattern
# `demo\_retail%` (demo_retail itself plus fixture databases such as
# demo_retail_v2) and nothing else: no FILE (so LOAD_FILE()/INTO OUTFILE are
# unavailable), no INSERT/UPDATE/DELETE/DDL, and no access to other schemas.
# This grant set is the real security boundary; the application-level SQL
# guardrails are defense in depth on top of it.
#
# Environment (passed through by docker-compose.yml):
#   DB_READONLY_USER      query user name (default: demo_readonly)
#   DB_READONLY_PASSWORD  its password (required; compose defaults it to DB_PASSWORD)

set -eo pipefail

_txt2sql_note() { printf '%s [Note] [txt2sql-initdb]: %s\n' "$(date --rfc-3339=seconds 2>/dev/null || date)" "$*"; }
_txt2sql_fail() {
  printf '%s [ERROR] [txt2sql-initdb]: %s\n' "$(date --rfc-3339=seconds 2>/dev/null || date)" "$*" >&2
  exit 1
}

if ! declare -F docker_process_sql >/dev/null 2>&1; then
  # Executed rather than sourced: talk to the temporary init server directly.
  docker_process_sql() {
    MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}" \
      mariadb --protocol=socket -uroot -hlocalhost --socket="${SOCKET:-/run/mysqld/mysqld.sock}" "$@"
  }
fi

if ! declare -F docker_sql_escape_string_literal >/dev/null 2>&1; then
  # Same escaping as the entrypoint helper: backslash, newline, single quote.
  docker_sql_escape_string_literal() {
    local newline=$'\n'
    local escaped=${1//\\/\\\\}
    escaped="${escaped//$newline/\\n}"
    echo "${escaped//\'/\\\'}"
  }
fi

_txt2sql_user="${DB_READONLY_USER:-demo_readonly}"
_txt2sql_password="${DB_READONLY_PASSWORD:-}"

# The user name is interpolated into SQL, so restrict it to a safe identifier.
if [[ ! "$_txt2sql_user" =~ ^[A-Za-z0-9_]{1,80}$ ]]; then
  _txt2sql_fail "DB_READONLY_USER must match [A-Za-z0-9_]{1,80}; got '${_txt2sql_user}'."
fi

if [ "$_txt2sql_user" = 'root' ]; then
  _txt2sql_fail 'DB_READONLY_USER must not be root: it names the least-privilege query user.'
fi

if [ -z "$_txt2sql_password" ]; then
  _txt2sql_fail "DB_READONLY_PASSWORD is required to create the '${_txt2sql_user}' query user. Set DB_READONLY_PASSWORD (or DB_PASSWORD) in .env, then reset the volume with 'docker compose down -v' and start again."
fi

_txt2sql_password_escaped="$(docker_sql_escape_string_literal "$_txt2sql_password")"

_txt2sql_note "Creating query user '${_txt2sql_user}'@'%' with SELECT on \`demo\\_retail%\`.*"

# NO_BACKSLASH_ESCAPES must be off for the escaped password literal (the
# entrypoint does the same for its own users). In the GRANT, `demo\_retail%`
# escapes the underscore so the pattern matches the literal prefix demo_retail.
printf '%s\n' \
  "SET @@SESSION.SQL_MODE=REPLACE(@@SESSION.SQL_MODE, 'NO_BACKSLASH_ESCAPES', '');" \
  "CREATE OR REPLACE USER '${_txt2sql_user}'@'%' IDENTIFIED BY '${_txt2sql_password_escaped}';" \
  "GRANT SELECT ON \`demo\\_retail%\`.* TO '${_txt2sql_user}'@'%';" \
  | docker_process_sql

_txt2sql_note "Query user '${_txt2sql_user}' is ready (SELECT-only on demo_retail*)."

unset _txt2sql_user _txt2sql_password _txt2sql_password_escaped
unset -f _txt2sql_note _txt2sql_fail
