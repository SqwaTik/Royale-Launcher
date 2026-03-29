!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var CreateDesktopShortcut
Var CreateStartMenuShortcut
Var ShortcutDesktopCheckbox
Var ShortcutStartMenuCheckbox

!macro customPageAfterChangeDir
  Page custom shortcutOptionsPageCreate shortcutOptionsPageLeave
!macroend

Function shortcutOptionsPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ReadRegStr $CreateDesktopShortcut SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" CreateDesktopShortcut
  ${If} $CreateDesktopShortcut == ""
    StrCpy $CreateDesktopShortcut "true"
  ${EndIf}

  ReadRegStr $CreateStartMenuShortcut SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" CreateStartMenuShortcut
  ${If} $CreateStartMenuShortcut == ""
    StrCpy $CreateStartMenuShortcut "true"
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Отметьте, где нужно добавить Royale Launcher."
  Pop $0

  ${NSD_CreateCheckbox} 0 32u 100% 14u "Создать ярлык на рабочем столе"
  Pop $ShortcutDesktopCheckbox
  ${If} $CreateDesktopShortcut == "true"
    ${NSD_Check} $ShortcutDesktopCheckbox
  ${EndIf}

  ${NSD_CreateCheckbox} 0 54u 100% 14u "Добавить ярлык в меню Пуск"
  Pop $ShortcutStartMenuCheckbox
  ${If} $CreateStartMenuShortcut == "true"
    ${NSD_Check} $ShortcutStartMenuCheckbox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function shortcutOptionsPageLeave
  ${NSD_GetState} $ShortcutDesktopCheckbox $0
  ${If} $0 == 1
    StrCpy $CreateDesktopShortcut "true"
  ${Else}
    StrCpy $CreateDesktopShortcut "false"
  ${EndIf}

  ${NSD_GetState} $ShortcutStartMenuCheckbox $0
  ${If} $0 == 1
    StrCpy $CreateStartMenuShortcut "true"
  ${Else}
    StrCpy $CreateStartMenuShortcut "false"
  ${EndIf}
FunctionEnd

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" CreateDesktopShortcut "$CreateDesktopShortcut"
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" CreateStartMenuShortcut "$CreateStartMenuShortcut"

  ${If} $CreateStartMenuShortcut == "true"
    !insertmacro createMenuDirectory
    ${IfNot} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  ${Else}
    Delete "$newStartMenuLink"
    ClearErrors
  ${EndIf}

  ${If} $CreateDesktopShortcut == "true"
    ${IfNot} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${Else}
    Delete "$newDesktopLink"
    ClearErrors
  ${EndIf}

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
