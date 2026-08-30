@echo off
chcp 65001 >nul
title 东方狂想 Gate A 测试
cd /d "%~dp0"
echo.
echo   ============================================
echo     东方狂想 Gate A - Prompt Play 测试
echo     （同一模型下与普通 AI Chat 对比）
echo   ============================================
echo.
echo   [1] Memory OFF 局（默认，先跑这局）
echo   [2] Memory ON 对照局
echo.
choice /c 12 /n /m "  选择模式 [1/2]: "
if errorlevel 2 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\dongfang\start-gate-a.ps1" -Memory on
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\dongfang\start-gate-a.ps1" -Memory off
)
echo.
pause
