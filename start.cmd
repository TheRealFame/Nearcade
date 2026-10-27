#!/bin/sh
# shellcheck disable=SC2039
: << 'BATCH_SECTION'
@echo off
goto :WINDOWS
BATCH_SECTION

# --- UNIX SECTION ---
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/bin/start.cmd" "$@"
exit 0

:WINDOWS
:: --- WINDOWS SECTION ---
@echo off
call "%~dp0bin\start.cmd" %*
