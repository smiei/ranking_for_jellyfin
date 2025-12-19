' Use pythonw.exe to start the tray launcher without opening a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
trayScript = projectRoot & "\tools\tray_launcher.py"

Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = projectRoot
oShell.Run "pythonw.exe """ & trayScript & """", 0, False
