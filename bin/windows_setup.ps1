$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host '--- Nearcade Automated Setup ---' -ForegroundColor Cyan

# Force the script to know exactly what folder it is running from
$ScriptPath = $PSScriptRoot

# 1. ViGEmBus Driver
$vigemCheck = Get-PnpDevice -FriendlyName 'ViGEmBus Device' -ErrorAction SilentlyContinue
if (!$vigemCheck) {
    Write-Host 'ViGEmBus driver not found. Installing...' -ForegroundColor Yellow

    # Securely point to the installer next to this script
    $vigemInstaller = Join-Path $ScriptPath 'ViGEmBus_Setup.exe'

    if (Test-Path $vigemInstaller) {
        Start-Process $vigemInstaller -Wait
        Write-Host 'Please ensure you completed the installer.' -ForegroundColor Cyan
    } else {
        Write-Host "ERROR: Could not find ViGEmBus_Setup.exe at $vigemInstaller" -ForegroundColor Red
        Write-Host "Make sure the file is actually inside the bin folder." -ForegroundColor Red
    }
} else {
    Write-Host '[✓] ViGEmBus driver is ready' -ForegroundColor Green
}

# 2. Python (Only needed if your gamepad sidecar still relies on Python)
if (!(Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host 'Python missing. Downloading...' -ForegroundColor Yellow
    Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.8/python-3.11.8-amd64.exe' -OutFile 'p.exe'
    Start-Process 'p.exe' -ArgumentList '/quiet InstallAllUsers=0 PrependPath=1' -Wait
    Remove-Item 'p.exe'
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
}

# 3. Python Requirements
Write-Host 'Installing Python dependencies...' -ForegroundColor Yellow
$reqFile = Join-Path $ScriptPath 'requirements-windows.txt'

if (Test-Path $reqFile) {
    pip install -r $reqFile
} else {
    # If the text file gets lost in compilation, fallback to direct installs
    Write-Host "Requirements file not found, installing defaults..." -ForegroundColor Yellow
    try {
        pip install pyautogui vgamepad pyaudio
    } catch {
        Write-Host "[WARN] PyAudio failed to install. The OS-level audio fallback will not work." -ForegroundColor Red
    }
}

# 4. Tunnels
$choice = Read-Host 'Tunnel? 1:Cloudflare 2:Zrok 3:Playit 4:Skip'
if ($choice -eq '1') { Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile "$HOME\cloudflared.exe" }
if ($choice -eq '2') {
    Invoke-WebRequest -Uri 'https://github.com/openziti/zrok/releases/latest/download/zrok_0.6.41_windows_amd64.zip' -OutFile 'z.zip'
    Expand-Archive -Path 'z.zip' -DestinationPath "$HOME\zrok" -Force
    Remove-Item 'z.zip'
}
if ($choice -eq '3') { Invoke-WebRequest -Uri 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64.exe' -OutFile "$HOME\playit.exe" }

Write-Host 'Done! You can close this window now.' -ForegroundColor Cyan
pause
