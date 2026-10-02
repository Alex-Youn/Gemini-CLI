@echo off
rem (2026-10 closed-network fork) gemini-cli-ollama install for Windows - run once in the unzipped folder.
rem No internet needed. Keep this file ASCII-only. Korean description: README.md
rem No parenthesized blocks: a ")" in the install path would end them early.
setlocal
set "PKG_DIR=%~dp0"
if "%PKG_DIR:~-1%"=="\" set "PKG_DIR=%PKG_DIR:~0,-1%"
set "GEMINI_HOME=%USERPROFILE%\.gemini"

echo [1/3] Config files
if exist "%PKG_DIR%\config\gemini-env.cmd" goto env_keep
copy /y "%PKG_DIR%\config\gemini-env.cmd.sample" "%PKG_DIR%\config\gemini-env.cmd" >nul
echo       created config\gemini-env.cmd - set the GPU server address in it
goto env_done
:env_keep
echo       keep config\gemini-env.cmd
:env_done

if not exist "%GEMINI_HOME%" mkdir "%GEMINI_HOME%"

if exist "%GEMINI_HOME%\settings.json" goto settings_keep
copy /y "%PKG_DIR%\config\settings.json.sample" "%GEMINI_HOME%\settings.json" >nul
echo       created "%GEMINI_HOME%\settings.json"
goto settings_done
:settings_keep
echo       keep "%GEMINI_HOME%\settings.json" - compare with config\settings.json.sample
:settings_done

if exist "%GEMINI_HOME%\GEMINI.md" goto md_keep
copy /y "%PKG_DIR%\config\GEMINI.md.sample" "%GEMINI_HOME%\GEMINI.md" >nul
echo       created "%GEMINI_HOME%\GEMINI.md"
goto md_done
:md_keep
echo       keep "%GEMINI_HOME%\GEMINI.md" - see config\GEMINI.md.sample
:md_done

echo [2/3] Run check
call "%PKG_DIR%\bin\gemini.cmd" --version
if errorlevel 1 goto failed

echo [3/3] Done. Add this folder to PATH, then open a new terminal:
echo       "%PKG_DIR%\bin"
echo.
echo       Next: edit config\gemini-env.cmd (GPU server address), then run "gemini" in your work folder.
exit /b 0

:failed
echo       FAILED to run gemini 1>&2
exit /b 1
