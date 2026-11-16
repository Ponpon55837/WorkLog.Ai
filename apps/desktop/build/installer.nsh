; Custom steps of the NSIS installer and uninstaller (electron-builder includes this file via the `nsis.include` option).
;
; DT-34: nothing here deletes the user's settings, database (~/.work-intelligence) or backups. The uninstaller removes
; program files only.

; Exit code 0 when this user's App process is running, 1 otherwise; result in $0. Another user's instance is ignored: it
; holds no file of this per-user install and must not make the installer wait.
!macro _WORKINTELLIGENCE_APP_RUNNING
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $0
!macroend

; Replaces electron-builder's check (it prompts and kills): ask the running App to quit itself so it stops its backend and
; frees its port, wait a bounded time, and only then end whatever is left. Runs in the installer and in the uninstaller.
;
; The wait must exceed the App's own worst-case quit (packages/desktop-core: quit-flow.ts DEFAULT_WAIT_LIMIT_MS and
; backend/types.ts DEFAULT_BACKEND_TIMEOUTS): 10 s for running operations + 10 s graceful backend stop + 3 s terminate +
; 3 s kill + 5 s port release = 31 s. Polling every 500 ms for up to 80 rounds waits 40 s, which leaves margin; a kill
; before that would interrupt an orderly shutdown (a database write in progress).
!macro customCheckAppRunning
  Push $0
  Push $1
  !insertmacro _WORKINTELLIGENCE_APP_RUNNING
  ${If} $0 == 0
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Asking ${PRODUCT_NAME} to quit"
      ; --quit exits 0 at once when no instance runs; /TIMEOUT bounds a hung instance (milliseconds).
      nsExec::Exec /TIMEOUT=20000 `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
      Pop $0
      StrCpy $1 0
      ${Do}
        !insertmacro _WORKINTELLIGENCE_APP_RUNNING
        ${If} $0 != 0
          ${ExitDo}
        ${EndIf}
        IntOp $1 $1 + 1
        ${If} $1 > 80
          ${ExitDo}
        ${EndIf}
        Sleep 500
      ${Loop}
    ${EndIf}
    !insertmacro _WORKINTELLIGENCE_APP_RUNNING
    ${If} $0 == 0
      DetailPrint "Ending ${PRODUCT_NAME}"
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /T /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $0
      ; Let Windows release the file handles before files are replaced.
      Sleep 1000
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend
