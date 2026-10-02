@echo off
rem (2026-10 closed-network fork) gemini-cli-ollama launcher for Windows.
rem Runs bundle\gemini.js with the Node runtime shipped in this package (system Node is not used).
rem Keep this file ASCII-only: cmd.exe reads batch files in the OEM code page.
rem No parenthesized blocks: a ")" in the install path would end them early.
setlocal
set "PKG_DIR=%~dp0.."

if exist "%PKG_DIR%\runtime\node\node.exe" goto run
echo Node runtime not found: "%PKG_DIR%\runtime\node\node.exe" 1>&2
exit /b 1

:run
rem GEMINI_OLLAMA_* defaults (values already set in the shell win)
if exist "%PKG_DIR%\config\gemini-env.cmd" call "%PKG_DIR%\config\gemini-env.cmd"

"%PKG_DIR%\runtime\node\node.exe" "%PKG_DIR%\bundle\gemini.js" %*
exit /b %ERRORLEVEL%
