@echo off
setlocal EnableDelayedExpansion
echo =================================================
echo  Nearcade Experimental Device Setup       
echo =================================================
echo 1) Install Experimental Dependencies (Python)
echo q) Quit
echo.
set /p confirm="Select an option: "

if /i "%confirm%"=="q" (
    echo Setup aborted.
    pause
    exit /b
)

if "%confirm%"=="1" (
    echo Installing dependencies...
    python -m pip install pynput mouse pyusb
)

echo =================================================
echo  Experimental setup complete!                    
echo =================================================
pause
