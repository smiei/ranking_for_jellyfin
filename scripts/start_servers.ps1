# Starts backend (Flask) and static http.server in separate PowerShell windows
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent $scriptDir
$backendDir = Join-Path $repoRoot "backend"
$frontendDir = Join-Path $repoRoot "frontend"

Set-Location $repoRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$backendDir`"; python server.py" -WindowStyle Normal -WorkingDirectory $backendDir
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$frontendDir`"; python -m http.server 8000" -WindowStyle Normal -WorkingDirectory $frontendDir

Write-Host "Started backend http://localhost:5000 and frontend http://localhost:8000/index.html"

# Open the frontend in default browser
Start-Process "http://localhost:8000/index.html"
