@echo off
echo =================================================
echo  NearsecTogether Experimental Device Setup       
echo =================================================
echo This script installs additional Python dependencies
echo required for the experimental hardware backends
echo (VR Headsets, Drawing Tablets, HOTAS, etc).
echo.
echo Note: Standard gamepads and keyboards do NOT require this.
echo.
set /p confirm="Install experimental dependencies? (y/n): "

if /i "%confirm%" neq "y" (
    echo Setup aborted.
    pause
    exit /b
)

echo Installing dependencies...
python -m pip install pynput mouse openvr pyusb

echo =================================================
echo  Experimental setup complete!                    
echo =================================================
pause
