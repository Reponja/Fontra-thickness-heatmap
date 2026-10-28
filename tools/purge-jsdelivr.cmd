@echo off
setlocal
node "%~dp0purge-jsdelivr.mjs" %*
if errorlevel 1 pause
