' Use pythonw.exe to start the tray launcher without opening a console window.
Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = "C:\Users\dermi\Documents\skripte\Jellyfin_Filme"
oShell.Run "pythonw.exe ""C:\Users\dermi\Documents\skripte\Jellyfin_Filme\tray_launcher.py""", 0, False
