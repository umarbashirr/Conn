@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\conn.exe" "%~dp0..\resources\app.asar.unpacked\cli\conn.js" %*
exit /b %errorlevel%
