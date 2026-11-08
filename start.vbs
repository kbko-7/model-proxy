' 无黑窗启动器：WScript 是 GUI 程序，不会闪任何控制台
Dim fso, dir_, sh
Set fso = CreateObject("Scripting.FileSystemObject")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir_ & "\.venv\Scripts\pythonw.exe"" """ & dir_ & "\app.py""", 0, False