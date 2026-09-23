Unicode True
!include "MUI2.nsh"

!ifndef STAGE
  !error "Pass /DSTAGE=<absolute staging directory>"
!endif
!ifndef OUTPUT
  !error "Pass /DOUTPUT=<absolute installer file>"
!endif

Name "Challenge Master"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\ChallengeMaster"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "0.4.0.0"
VIAddVersionKey "ProductName" "Challenge Master"
VIAddVersionKey "FileDescription" "Challenge Master Windows installer"
VIAddVersionKey "FileVersion" "0.4.0"
VIAddVersionKey "ProductVersion" "0.4.0"
VIAddVersionKey "LegalCopyright" "Copyright 2026 Challenge Master contributors"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
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
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "DisplayVersion" "0.4.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "Publisher" "Challenge Master"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChallengeMaster" "NoRepair" 1
SectionEnd

Section "Uninstall"
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

  ; Student records in $LOCALAPPDATA\ChallengeMaster are intentionally preserved.
SectionEnd
