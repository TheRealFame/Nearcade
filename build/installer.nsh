!include "LogicLib.nsh"

; This runs the moment the user opens the Setup / Installer .exe
!macro customInit
  ; Silently kill all instances of the app and its child processes
  nsExec::Exec "taskkill /F /IM Nearcade.exe /T"
!macroend

; This runs the moment the user clicks Uninstall
!macro customUnInit
  ; Silently kill all instances of the app before deleting files
  nsExec::Exec "taskkill /F /IM Nearcade.exe /T"
!macroend

!macro customUnInstall
  MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "Would you like to remove the ViGEmBus virtual controller driver?$\n$\n(Select 'No' if you use it for other apps like DS4Windows)" IDNO keep_vigem
    DetailPrint "Uninstalling ViGEmBus..."
    ${If} ${FileExists} "$INSTDIR\ViGEmBus_Setup.exe"
      ExecWait '"$INSTDIR\ViGEmBus_Setup.exe" /uninstall /quiet'
    ${ElseIf} ${FileExists} "$INSTDIR\resources\bin\setup\ViGEmBus_Setup.exe"
      ExecWait '"$INSTDIR\resources\bin\setup\ViGEmBus_Setup.exe" /uninstall /quiet'
    ${EndIf}
  keep_vigem:
!macroend

!macro customInstall
  ; Check if ViGEmBus is already installed
  nsExec::ExecToStack 'powershell -NoProfile -Command "if (Get-PnpDevice -FriendlyName ''ViGEmBus Device'' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
  Pop $0
  Pop $1 ; The output string
  
  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONQUESTION "The ViGEmBus driver is not installed on this system.$\n$\nNearcade requires this driver to emulate virtual Xbox controllers for your viewers.$\n$\nWould you like to download and install it now?" IDYES installVigem IDNO skipVigem
    installVigem:
      DetailPrint "Downloading ViGEmBus..."
      nsisdl::download "https://github.com/nefarius/ViGEmBus/releases/latest/download/ViGEmBus_Setup.exe" "$INSTDIR\ViGEmBus_Setup.exe"
      Pop $0
      ${If} $0 == "success"
        DetailPrint "Running ViGEmBus Installer..."
        ExecWait '"$INSTDIR\ViGEmBus_Setup.exe"'
      ${EndIf}
    skipVigem:
  ${EndIf}
  WriteRegStr HKCU "Software\Nearcade" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
!macroend
