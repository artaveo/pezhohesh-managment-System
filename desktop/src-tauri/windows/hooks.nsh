; Extra steps for the Windows installer (Tauri NSIS hooks).

!macro NSIS_HOOK_POSTINSTALL
  ; Always put the app on the desktop, also for silent installs and updates,
  ; where Tauri's own "create desktop shortcut" checkbox is never shown.
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
