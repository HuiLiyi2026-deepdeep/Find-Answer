Option Explicit

Dim fileSystem, projectRoot, launcherPath, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
projectRoot = fileSystem.GetParentFolderName(fileSystem.GetParentFolderName(WScript.ScriptFullName))
launcherPath = fileSystem.BuildPath(projectRoot, "scripts\start-findanswer.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcherPath & """"
CreateObject("WScript.Shell").Run command, 0, False
