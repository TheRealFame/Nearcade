@echo off
setlocal EnableDelayedExpansion
echo =================================================
echo  Nearcade Experimental Device Setup       
echo =================================================
echo 1) VR Headset (SteamVR driver installation)
echo 0) Install everything
echo q) Quit
echo.
set /p confirm="Select an option: "

if /i "%confirm%"=="q" (
    echo Setup aborted.
    pause
    exit /b
)

echo Installing dependencies...
python -m pip install pynput mouse openvr pyusb

if "%confirm%"=="1" goto install_vr
if "%confirm%"=="0" goto install_vr
goto end

:install_vr
echo =================================================
echo  Installing NearsecVR SteamVR Driver
echo =================================================
set DRIVER_SRC="%~dp0..\src\sidecar\input_backends\experimental\steamvr_driver\build\Release\driver_nearsecvr.dll"

if not exist %DRIVER_SRC% (
    echo Error: driver_nearsecvr.dll not found! Please build it first using CMake.
) else (
    REM Try to find Steam installation path from Registry
    set STEAM_PATH=
    for /f "tokens=2,*" %%A in ('reg query HKCU\Software\Valve\Steam /v SteamPath 2^>nul') do (
        set STEAM_PATH=%%B
    )
    
    if defined STEAM_PATH (
        REM Convert slashes
        set STEAM_PATH=!STEAM_PATH:/=\!
        set STEAMVR_PATH="!STEAM_PATH!\steamapps\common\SteamVR\drivers"
    ) else (
        set STEAMVR_PATH="C:\Program Files (x86)\Steam\steamapps\common\SteamVR\drivers"
    )

    mkdir "%STEAMVR_PATH%\nearsecvr\bin\win64" 2>nul
    copy /Y %DRIVER_SRC% "%STEAMVR_PATH%\nearsecvr\bin\win64\" >nul
    echo {"name": "nearsecvr", "version": "1.0", "alwaysActivate": true} > "%STEAMVR_PATH%\nearsecvr\driver.vrdrivermanifest"
    echo Installed SteamVR driver to: %STEAMVR_PATH%
)

:end
echo =================================================
echo  Experimental setup complete!                    
echo =================================================
pause
