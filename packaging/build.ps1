param(
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$frontend = Join-Path $root 'frontend'
$backend = Join-Path $root 'backend'
$venv = Join-Path $PSScriptRoot '.venv-build'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$outDir = Join-Path $PSScriptRoot 'out'
$workDir = Join-Path $PSScriptRoot 'work'
$appDir = Join-Path $outDir 'FindAnswer'

Write-Host '[1/5] Building frontend in local mode...'
if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
    Push-Location $frontend
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally {
        Pop-Location
    }
}
Push-Location $frontend
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally {
    Pop-Location
}

Write-Host '[2/5] Preparing the local build environment...'
if (-not (Test-Path $venvPython)) {
    & $Python -m venv --system-site-packages $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the build virtual environment.' }
}
& $venvPython -m pip install --disable-pip-version-check --no-cache-dir --retries 10 --timeout 60 -r (Join-Path $backend 'requirements.txt') pyinstaller "pywebview>=5,<6"
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

Write-Host '[3/5] Packaging FindAnswer.exe...'
& $venvPython -m PyInstaller --noconfirm --clean --distpath $outDir --workpath $workDir (Join-Path $PSScriptRoot 'FindAnswer.spec')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed.' }

Write-Host '[4/5] Adding usage notes...'
Copy-Item (Join-Path $PSScriptRoot 'README.txt') (Join-Path $appDir 'README.txt') -Force

Write-Host '[5/5] Creating the zip archive...'
$zip = Join-Path $outDir 'FindAnswer-win11-x64.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
    $appDir,
    $zip,
    [IO.Compression.CompressionLevel]::Optimal,
    $true
)

$sizeMb = [math]::Round(((Get-Item $zip).Length / 1MB), 1)
Write-Host "Done: $zip ($sizeMb MB)"
