; Custom uninstall steps for Zoom Stream Automation (included by electron-builder's NSIS script).
!macro customUnInstall
  ; Upgrades run the old uninstaller silently; keep the user's schedule and settings in that case.
  ${IfNot} ${isUpdated}
    ; Remove the Windows scheduled task and the sign-in entry the app may have created.
    nsExec::Exec 'schtasks.exe /Delete /TN "ZoomStreamAutomation-ScheduledStream" /F'
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZoomStreamAutomation"
    ; Settings are deleted only when the user chose that in the app's Uninstall dialog.
    ${If} ${FileExists} "$APPDATA\Zoom Stream Automation\remove-data-on-uninstall"
      RMDir /r "$APPDATA\Zoom Stream Automation"
    ${EndIf}
  ${EndIf}
!macroend
