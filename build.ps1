# Build the portable desktop app: "SYNTHOA\SYNTHOA.exe" plus a zip.
#
# Needs on the build PC: Python 3.11+ and Node.js 20+ (the target PC needs neither).
# Everything (build environments, intermediate files, output) goes OUTSIDE this
# folder by default, so OneDrive does not sync the build files.
#
#   .\build.ps1                       # build
#   .\build.ps1 -OutDir D:\builds     # somewhere else
#   .\build.ps1 -Clean                # recreate the build environments from scratch

param(
    [string]$OutDir = (Join-Path $env:LOCALAPPDATA "SynthoaBuild"),
    [switch]$Clean
)

# Native tools (pip, npm, PyInstaller) write progress and warnings to stderr; judge them by
# their exit codes, not by stderr (PowerShell 5.1 would otherwise abort on the first warning).
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$venv = Join-Path $OutDir "venv"
$python = Join-Path $venv "Scripts\python.exe"
$web = Join-Path $OutDir "frontend"
$dist = Join-Path $OutDir "dist"
$appFolder = Join-Path $dist "SYNTHOA"
$zip = Join-Path $OutDir "SYNTHOA-win64.zip"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

if ($Clean -and (Test-Path $OutDir)) {
    Step "Removing $OutDir"
    Remove-Item -Recurse -Force $OutDir -ErrorAction Stop
}
New-Item -ItemType Directory -Force $OutDir | Out-Null

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node.js not found. Install Node.js 20+ from nodejs.org." }

Step "Building the frontend"
# A copy outside the source folder; node_modules is kept between builds.
& robocopy (Join-Path $root "frontend") $web /MIR /NFL /NDL /NJH /NJS /NP /XD node_modules .next out | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the frontend failed." }
Push-Location $web
try {
    & npm ci --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    $env:STATIC_EXPORT = "1"
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
} finally {
    Remove-Item Env:STATIC_EXPORT -ErrorAction SilentlyContinue
    Pop-Location
}

if (-not (Test-Path $python)) {
    Step "Creating build environment in $venv"
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) { & py -3 -m venv $venv } else { & python -m venv $venv }
    if (-not (Test-Path $python)) { throw "Could not create the build environment. Install Python 3.11+ from python.org." }
}

Step "Installing dependencies (first time: a few minutes)"
& $python -m pip install --quiet --upgrade pip
& $python -m pip install --quiet -r (Join-Path $root "backend\requirements.txt") pywebview pyinstaller
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

Step "Pre-downloading the tokenizer"
# Bundled so token estimates are exact offline; desktop.py points TIKTOKEN_CACHE_DIR at data\tiktoken.
$tiktoken = Join-Path $OutDir "tiktoken"
$env:TIKTOKEN_CACHE_DIR = $tiktoken
& $python -c "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')"
Remove-Item Env:TIKTOKEN_CACHE_DIR -ErrorAction SilentlyContinue

Step "Building with PyInstaller"
$env:SYNTHOA_WEB_DIR = Join-Path $web "out"
& $python -m PyInstaller --noconfirm --clean `
    --distpath $dist --workpath (Join-Path $OutDir "work") `
    (Join-Path $root "synthoa.spec")
$pyinstallerExit = $LASTEXITCODE
Remove-Item Env:SYNTHOA_WEB_DIR -ErrorAction SilentlyContinue
if ($pyinstallerExit -ne 0) { throw "PyInstaller failed." }

if (Test-Path $tiktoken) {
    New-Item -ItemType Directory -Force (Join-Path $appFolder "data") | Out-Null
    Copy-Item $tiktoken (Join-Path $appFolder "data\tiktoken") -Recurse -Force
}
Copy-Item (Join-Path $root "README.md") (Join-Path $appFolder "README.md") -Force

Step "Creating $zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
& tar.exe -a -c -f $zip -C $dist "SYNTHOA"
if ($LASTEXITCODE -ne 0) { throw "Creating the zip failed." }

$sizeMb = [math]::Round(((Get-ChildItem -Recurse $appFolder | Measure-Object Length -Sum).Sum) / 1MB)
$zipMb = [math]::Round((Get-Item $zip).Length / 1MB)
Write-Host "`nDone." -ForegroundColor Green
Write-Host "  $appFolder ($sizeMb MB)"
Write-Host "  $zip ($zipMb MB)"
Write-Host "  Run 'SYNTHOA.exe' inside the folder. Your data is kept in its data\ subfolder."
