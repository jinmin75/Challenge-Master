Unicode True
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"

!ifndef STAGE
  !error "Pass /DSTAGE=<absolute staging directory>"
!endif
!ifndef OUTPUT
  !error "Pass /DOUTPUT=<absolute installer file>"
!endif
!ifndef VERSION
  !error "Pass /DVERSION=<major.minor.patch>"
!endif

Name "Challenge Master"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\ChallengeMaster"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Challenge Master"
VIAddVersionKey "FileDescription" "Challenge Master Windows installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright 2026 Challenge Master contributors"

!define MUI_COMPONENTSPAGE_NODESC

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!define MUI_COMPONENTSPAGE_TEXT_TOP "앱은 항상 제거됩니다. 개인 학습 기록과 PDF 사본은 아래 칸을 선택한 경우에만 삭제됩니다."
!insertmacro MUI_UNPAGE_COMPONENTS
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"

Section "Challenge Master" MainSection
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Challenge Master"
  CreateShortCut "$SMPROGRAMS\Challenge Master\Challenge Master.lnk" "$SYSDIR\wscript.exe" "$\"$INSTDIR\launch.vbs$\""
  CreateShortCut "$SMPROGRAMS\Challenge Master\제거.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "DisplayName" "Challenge Master"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "Publisher" "Challenge Master"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "NoRepair" 1
SectionEnd

Section "-un.Challenge Master" UnMainSection
  SetShellVarContext current
  Delete "$SMPROGRAMS\Challenge Master\Challenge Master.lnk"
  Delete "$SMPROGRAMS\Challenge Master\제거.lnk"
  RMDir "$SMPROGRAMS\Challenge Master"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster"

  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\launch.vbs"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd

; Unselected by default: records survive unless the student ticks this box
; or a silent uninstall passes /DELETEDATA explicitly.
Section /o "un.개인 학습 기록·PDF 사본도 삭제" UnDataSection
  SetShellVarContext current
  ${If} $LOCALAPPDATA == ""
    DetailPrint "사용자 데이터 위치를 찾지 못해 기록을 삭제하지 않았습니다."
    Return
  ${EndIf}
  RMDir /r "$LOCALAPPDATA\ChallengeMaster"
  ${If} ${FileExists} "$LOCALAPPDATA\ChallengeMaster\*.*"
    DetailPrint "일부 기록을 삭제하지 못했습니다: $LOCALAPPDATA\ChallengeMaster"
    SetErrorLevel 2
  ${Else}
    DetailPrint "개인 학습 기록을 삭제했습니다."
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  ; A running app keeps node.exe open for execution, so opening it for append fails.
  ClearErrors
  FileOpen $0 "$INSTDIR\runtime\node\node.exe" a
  ${If} ${Errors}
    ${IfNot} ${FileExists} "$INSTDIR\runtime\node\node.exe"
      Goto options
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Challenge Master가 실행 중입니다. 앱 화면의 [앱 종료]를 누른 뒤 다시 제거하십시오." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  FileClose $0
  options:
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DELETEDATA" $R1
  ${IfNot} ${Errors}
    !insertmacro SelectSection ${UnDataSection}
  ${EndIf}
FunctionEnd
