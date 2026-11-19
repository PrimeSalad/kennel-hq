# Kennel HQ installer for Windows (PowerShell).
#   irm https://raw.githubusercontent.com/PrimeSalad/kennel-hq/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = 'PrimeSalad/kennel-hq'
$Pkg = 'kennel-hq'
$Tarball = "https://codeload.github.com/$Repo/tar.gz/main"

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) { Write-Host "x $text" -ForegroundColor Red; return }

Write-Host ''
Write-Host '* Kennel HQ' -ForegroundColor Magenta -NoNewline
Say ' - an AI dev team of pixel-art dogs, powered by Claude Code' DarkGray
Write-Host ''

# 1. Node.js 22+
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js 22 or newer is needed. Get it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then open a new terminal and run this again.'; return
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { Fail "Node.js $(node -v) is too old. Kennel needs 22 or newer: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)."; return }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm wasn't found. It comes with Node.js: https://nodejs.org"; return }
Say "  node $(node -v)" DarkGray

# 2. Install: from npm if it's published there, otherwise straight from GitHub.
$src = $Tarball
npm view $Pkg version *> $null
if ($LASTEXITCODE -eq 0) { $src = $Pkg }
Say "  installing $src" DarkGray
npm install -g $src --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Try again in a terminal opened as Administrator, or check your internet connection.'; return }

# 3. Claude Code (the dogs run on your own Claude login, no API key)
$claude = (Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path "$HOME\.local\bin\claude.exe")
if ($claude) { Say '  claude code found' DarkGray }
else {
  Write-Host ''
  Say "! Claude Code isn't installed yet. The dogs need it:" Yellow
  Say '    irm https://claude.ai/install.ps1 | iex'
  Say '  then run  claude  once to log in.'
}

Write-Host ''
Say 'Kennel HQ is installed.' Magenta
Write-Host ''
Say '  cd your-project'
Say '  kennel                 # opens the pack in the terminal + the office in your browser'
Say '  kennel install-skill   # optional: use the pack from inside Claude Code (/kennel)'
Write-Host ''
if (-not (Get-Command kennel -ErrorAction SilentlyContinue)) { Say "! Open a new terminal if 'kennel' isn't found yet." Yellow }
