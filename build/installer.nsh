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
