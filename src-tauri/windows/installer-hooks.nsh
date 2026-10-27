; Musify installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).

; After an install or update: Windows caches program icons, also those of shortcuts pinned to the
; taskbar, so a new app icon would only show up after a restart. SHChangeNotify(SHCNE_ASSOCCHANGED)
; asks the shell to reload them.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
