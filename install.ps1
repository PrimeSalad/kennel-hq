# Kennel HQ installer for Windows. One command, nothing else needed first:
#   irm https://raw.githubusercontent.com/PrimeSalad/kennel-hq/main/install.ps1 | iex
# Installs Node.js (a private copy, no admin) if yours is missing or too old, Claude Code if it's missing,
# and the `kennel` command. Run it again any time to update.
$ErrorActionPreference = 'Continue'  # native npm calls write to stderr; exit codes are checked instead
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with the progress bar on

$Repo = 'PrimeSalad/kennel-hq'
$Pkg = 'kennel-hq'
$Tarball = "https://codeload.github.com/$Repo/tar.gz/main"
$KennelHome = if ($env:KENNEL_HOME) { $env:KENNEL_HOME } else { Join-Path $HOME '.kennel' }
$NodeDir = Join-Path $KennelHome 'node'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) { Write-Host "x $text" -ForegroundColor Red }
function Add-UserPath($dir) {
  if ($env:KENNEL_NO_PATH) { return }  # used by tests
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($user -split ';' | Where-Object { $_ })
  if ($parts -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', (@($dir) + $parts) -join ';', 'User') }
}
function Get-NodeMajor {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}

Write-Host ''
Write-Host '* Kennel HQ' -ForegroundColor Magenta -NoNewline
Say ' - an AI dev team of pixel-art dogs, powered by Claude Code' DarkGray
Write-Host ''

# 1. Node.js 22+: use yours if it's new enough, otherwise a private copy in ~/.kennel/node.
if (Test-Path (Join-Path $NodeDir 'node.exe')) { $env:Path = "$NodeDir;$env:Path" }
if ($env:KENNEL_FORCE_PORTABLE -or (Get-NodeMajor) -lt 22) {
  Say '  getting Node.js 22 (a private copy for Kennel, no admin needed)...' DarkGray
  try {
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $ver = ($index | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-$ver-win-$arch"
    $zip = Join-Path ([IO.Path]::GetTempPath()) "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip -UseBasicParsing -ErrorAction Stop
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "kennel-node-$([guid]::NewGuid())"
    # .NET's unzip directly: Expand-Archive breaks on some PowerShell 5.1 setups.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force (Split-Path $NodeDir) | Out-Null
    Move-Item (Join-Path $tmp $name) $NodeDir -ErrorAction Stop
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $env:Path = "$NodeDir;$env:Path"
    Add-UserPath $NodeDir
  } catch { Fail "Couldn't download Node.js ($($_.Exception.Message)). Install it from https://nodejs.org and run this again."; return }
}
Say "  node $(node -v)" DarkGray

# 2. Kennel itself: from npm if it's published there, otherwise straight from GitHub.
$src = $Tarball
npm view $Pkg version *> $null
if ($LASTEXITCODE -eq 0) { $src = $Pkg }
Say "  installing kennel from $(if ($src -eq $Pkg) { 'npm' } else { 'GitHub' })..." DarkGray
npm install -g $src --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail 'Installing kennel failed. Check your internet connection and run this again.'; return }
# npm's global folder (usually %APPDATA%\npm) holds kennel.cmd. On a fresh machine it isn't on PATH yet.
$prefix = "$(npm prefix -g)".Trim()
if ($prefix -and (Test-Path $prefix)) {
  $known = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')) -split ';' | ForEach-Object { $_.TrimEnd('\') })
  if ($known -notcontains $prefix.TrimEnd('\')) { Add-UserPath $prefix }
  $env:Path = "$prefix;$env:Path"
}

# 3. Claude Code: the dogs run on your own Claude login (no API key).
$claudeExe = Join-Path $HOME '.local\bin\claude.exe'
if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path $claudeExe)) { Say '  claude code found' DarkGray }
elseif ($env:KENNEL_NO_CLAUDE) { Say '  skipping Claude Code (KENNEL_NO_CLAUDE is set)' DarkGray }
else {
  Say '  installing Claude Code (official installer)...' DarkGray
  try { Invoke-RestMethod 'https://claude.ai/install.ps1' | Invoke-Expression } catch { Fail "Couldn't install Claude Code: $($_.Exception.Message). Get it from https://claude.com/claude-code" }
}

Write-Host ''
Say 'Kennel HQ is installed.' Magenta
Write-Host ''
Say '  Open a NEW terminal, then:'
Say '  claude                 # first time only: log in to your Claude account'
Say '  cd your-project'
Say '  kennel                 # the pack in the terminal + the office in your browser'
Say '  kennel install-skill   # optional: use the pack from inside Claude Code (/kennel)'
Write-Host ''
