@echo off
rem 调试启动：带控制台，能看到 node 内核日志；正常使用请用 start.vbs 或桌面快捷方式
cd /d "%~dp0"
".venv\Scripts\python.exe" app.py