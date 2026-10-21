; Per-user install only: skip the "for me / for all users" page (no administrator rights).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Windows Settings > Installed apps reads the folder from the uninstall entry; electron-builder records it
; only under Software\<app GUID> (which an upgrade reads to default to the existing folder).
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
!macroend

; After the Choose Install Location page: check the folder before installing. The installer never asks for
; administrator rights, so a folder the user can't write (e.g. Program Files) gets a clear message instead
; of a failed install. A folder holding other files is refused too: the uninstaller deletes the whole folder.
; The page is skipped when the folder is fine.
!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  Var installFolderProblem

  Page custom installFolderCheck installFolderCheckLeave

  Function installFolderCheck
    ; The folder the install will use: electron-builder adds \${APP_FILENAME} when the chosen path lacks it.
    ${StrContains} $R0 "${APP_FILENAME}" $INSTDIR
    ${If} $R0 == ""
      StrCpy $R1 "$INSTDIR\${APP_FILENAME}"
    ${Else}
      StrCpy $R1 "$INSTDIR"
    ${EndIf}
    StrCpy $installFolderProblem ""

    ${If} ${FileExists} "$R1\*.*"
    ${AndIfNot} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
      FindFirst $0 $1 "$R1\*.*"
      ${DoWhile} $1 != ""
        ${If} $1 != "."
        ${AndIf} $1 != ".."
          StrCpy $installFolderProblem "The folder $R1 already holds other files. Uninstalling ${PRODUCT_NAME} removes its whole folder, so it needs a new or empty folder.$\r$\n$\r$\nClick Back and choose another folder."
          ${Break}
        ${EndIf}
        FindNext $0 $1
      ${Loop}
      FindClose $0
    ${EndIf}

    ${If} $installFolderProblem == ""
      StrCpy $R2 "0"
      ${IfNot} ${FileExists} "$R1\*.*"
        ClearErrors
        CreateDirectory "$R1"
        StrCpy $R2 "1"
      ${EndIf}
      ClearErrors
      FileOpen $0 "$R1\.quotebridge-write-test" w
      ${If} ${Errors}
        StrCpy $installFolderProblem "${PRODUCT_NAME} can't write to $R1.$\r$\n$\r$\nIt installs for your Windows user only and never asks for administrator rights, so it can't use folders such as Program Files. Click Back and choose a folder you can write to, for example one inside $PROFILE."
      ${Else}
        FileClose $0
        Delete "$R1\.quotebridge-write-test"
      ${EndIf}
      ; Leave no trace of the check: the install creates the folder again (RMDir without /r removes it only when empty).
      ${If} $R2 == "1"
        RMDir "$R1"
      ${EndIf}
    ${EndIf}

    ${If} $installFolderProblem == ""
      Abort ; the folder is fine: skip this page
    ${EndIf}

    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 100% "$installFolderProblem"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  ; Next stays on this page: the folder has to change first.
  Function installFolderCheckLeave
    Abort
  FunctionEnd
!macroend
