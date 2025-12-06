# Starts backend (Flask) and static http.server in separate PowerShell windows
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$scriptDir`"; python server.py" -WindowStyle Normal -WorkingDirectory $scriptDir
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$scriptDir`"; python -m http.server 8000" -WindowStyle Normal -WorkingDirectory $scriptDir

Write-Host "Started backend http://localhost:5000 and frontend http://localhost:8000/index.html"

# Open the frontend in default browser
Start-Process "http://localhost:8000/index.html"
