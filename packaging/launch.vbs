Option Explicit

Dim shell, files, root, node, entry
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
node = root & "\runtime\node\node.exe"
entry = root & "\app\src\desktop.mjs"
shell.CurrentDirectory = root & "\app"
shell.Run Chr(34) & node & Chr(34) & " " & Chr(34) & entry & Chr(34), 0, False
