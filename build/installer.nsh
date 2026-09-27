; The PATH edit goes through PowerShell rather than raw registry writes. The
; user PATH is REG_EXPAND_SZ, it has a length limit worth respecting, and
; SetEnvironmentVariable broadcasts the change so a shell opened afterwards
; sees it. Hand-rolling that in NSIS is a well known way to eat somebody's PATH.
;
; PATH gets $INSTDIR\bin, not $INSTDIR. conn.exe and conn.cmd cannot share
; a PATH directory: default PATHEXT puts .EXE before .CMD, so bare `conn`
; would launch the GUI.

!macro connRunPS Script
  InitPluginsDir
  FileOpen $9 "$PLUGINSDIR\conn-path.ps1" w
  FileWrite $9 "${Script}"
  FileClose $9
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\conn-path.ps1"'
  Pop $9
!macroend

!macro customInstall
  Delete "$INSTDIR\conn.cmd"

  !insertmacro connRunPS "$$dir = '$INSTDIR'; $$bin = '$INSTDIR\bin'; $$p = [Environment]::GetEnvironmentVariable('Path','User'); if ($$null -eq $$p) { $$p = '' }; $$kept = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$dir -and $$_ -ne $$bin }); $$kept += $$bin; [Environment]::SetEnvironmentVariable('Path', ($$kept -join ';'), 'User')"

  ; %V is the folder in both cases; %1 is not, for the background verb.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conn" "" "Open with Conn"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conn" "Icon" "$INSTDIR\conn.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conn\command" "" '"$INSTDIR\conn.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conn" "" "Open with Conn"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conn" "Icon" "$INSTDIR\conn.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conn\command" "" '"$INSTDIR\conn.exe" "%V"'
!macroend

!macro customUnInstall
  !insertmacro connRunPS "$$dir = '$INSTDIR'; $$bin = '$INSTDIR\bin'; $$p = [Environment]::GetEnvironmentVariable('Path','User'); if ($$p) { $$kept = ($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$dir -and $$_ -ne $$bin }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $$kept, 'User') }"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Conn"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Conn"
!macroend
