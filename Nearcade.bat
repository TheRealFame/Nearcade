@echo off
:: Move to the root directory where this script sits
cd /d "%~dp0"

:: Set an environment variable so the sub-script knows it's being proxied
set IS_PROXIED=true

:: Launch the actual polyglot script
call bin\start.cmd