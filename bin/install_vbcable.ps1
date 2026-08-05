# Install VB-Audio Virtual Cable (Windows Virtual Microphone for Nearcade)
# This script requires Administrator privileges.

Write-Host "============================================================"
Write-Host "  Nearcade Windows Experimental Features"
Write-Host "  Virtual Microphone Routing Setup (VB-Audio Virtual Cable)"
Write-Host "============================================================"
Write-Host ""

if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "WARNING: This script must be run as Administrator to install the virtual audio driver." -ForegroundColor Yellow
    Write-Host "Please restart PowerShell as Administrator and run this script again."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit
}

$InstallDir = "$env:TEMP\VBCable_Setup"
$ZipFile = "$env:TEMP\VBCable_Setup.zip"
$DownloadUrl = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip"

Write-Host "1) Downloading VB-Audio Virtual Cable..."
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipFile -UseBasicParsing
} catch {
    Write-Host "FAILED to download VB-Cable. Please download and install it manually from https://vb-audio.com/Cable/" -ForegroundColor Red
    exit
}

Write-Host "2) Extracting driver package..."
if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
}
Expand-Archive -Path $ZipFile -DestinationPath $InstallDir -Force

Write-Host "3) Installing Virtual Audio Cable (Silent Mode)..."
$SetupExe = "$InstallDir\VBCABLE_Setup_x64.exe"
if (-Not (Test-Path $SetupExe)) {
    Write-Host "Could not find x64 installer in the package. Check $InstallDir." -ForegroundColor Red
    exit
}

# Run the installer silently
$process = Start-Process -FilePath $SetupExe -ArgumentList "-i", "-h" -Wait -PassThru

if ($process.ExitCode -eq 0) {
    Write-Host "VB-Audio Virtual Cable installed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "IMPORTANT: You may need to REBOOT your computer for the audio devices to appear." -ForegroundColor Yellow
    Write-Host "After reboot, Nearcade will automatically detect 'CABLE Input' as the virtual microphone."
} else {
    Write-Host "Installation failed or was cancelled (Exit Code: $($process.ExitCode))." -ForegroundColor Red
    Write-Host "Please try installing manually by running $SetupExe"
}

# Cleanup
Remove-Item $ZipFile -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue

Write-Host ""
Read-Host "Press Enter to exit"
