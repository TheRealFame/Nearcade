$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host '--- Nearcade Automated Setup ---' -ForegroundColor Cyan

# Force the script to know exactly what folder it is running from
$ScriptPath = $PSScriptRoot

# 1. ViGEmBus Driver — check for the actual driver file, same as Nearcade's IPC does
$vigemSys = 'C:\Windows\System32\drivers\ViGEmBus.sys'
$vigemCheck = Test-Path $vigemSys
if (!$vigemCheck) {
    Write-Host 'ViGEmBus driver not found. Installing...' -ForegroundColor Yellow

    # Securely point to the installer next to this script
    $vigemInstaller = Join-Path $ScriptPath 'ViGEmBus_Setup.exe'

    if (Test-Path $vigemInstaller) {
        $proc = Start-Process $vigemInstaller -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Host "ViGEmBus installer exited with code $($proc.ExitCode)" -ForegroundColor Red
        } else {
            Write-Host '[✓] ViGEmBus installed successfully.' -ForegroundColor Green
        }
    } else {
        Write-Host "ERROR: Could not find ViGEmBus_Setup.exe at $vigemInstaller" -ForegroundColor Red
        Write-Host "Make sure the file is actually inside the bin folder." -ForegroundColor Red
    }
} else {
    Write-Host '[✓] ViGEmBus driver is already installed' -ForegroundColor Green
}


Write-Host 'Done! This window will close automatically in 3 seconds...' -ForegroundColor Cyan
Start-Sleep -Seconds 3
