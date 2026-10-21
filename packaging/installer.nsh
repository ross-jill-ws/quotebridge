; Per-user install only: skip the "for me / for all users" page (no administrator rights).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
