<#
.SYNOPSIS
    Packages and signs Nightjar for Samsung Tizen OS 10 (.wgt) and optionally installs it to a Samsung TV.
.EXAMPLE
    .\tizen\build-wgt.ps1
    .\tizen\build-wgt.ps1 -Profile leonardosth2 -TvIp 192.168.1.120
#>
param(
    [string]$Profile = "",
    [string]$TvIp = "",
    [switch]$SkipTests,
    [switch]$FetchLatestWasm,
    [string]$RunId = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $PSScriptRoot "app"
$WasmDir = Join-Path $AppDir "wasm"
$DistDir = Join-Path $PSScriptRoot "dist"

if ($FetchLatestWasm -or $RunId -ne "") {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI (gh) is required to download WASM artifacts."
    }
    $TargetRunId = $RunId
    if ($TargetRunId -eq "") {
        $TargetRunId = (& gh run list -R leonardosth/nightjar --branch tizen --workflow tizen.yml --status success --limit 1 --json databaseId -q ".[0].databaseId")
        if ($LASTEXITCODE -ne 0 -or -not $TargetRunId) {
            throw "Failed to locate a successful tizen.yml GitHub Actions run."
        }
    }
    Write-Host "==> Downloading nightjar-tizen-wasm from GitHub Actions run $TargetRunId..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $WasmDir | Out-Null
    & gh run download $TargetRunId -R leonardosth/nightjar -n nightjar-tizen-wasm -D $WasmDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to download nightjar-tizen-wasm artifact from run $TargetRunId." }
}

if (-not (Test-Path (Join-Path $WasmDir "nightjar_tizen.wasm"))) {
    throw "Missing tizen/app/wasm/nightjar_tizen.wasm. Run with -FetchLatestWasm or build tizen/Dockerfile first."
}

if (-not $SkipTests) {
    Write-Host "==> Running Nightjar Tizen unit tests..." -ForegroundColor Cyan
    node --test (Join-Path $PSScriptRoot "tests\frame-warp.test.mjs") (Join-Path $PSScriptRoot "tests\tv-runtime-and-input.test.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Nightjar Tizen unit tests failed." }
}

# Ensure icon.png exists in tizen/app/
$IconPath = Join-Path $AppDir "icon.png"
if (-not (Test-Path $IconPath)) {
    $AndroidIcon = Join-Path $RepoRoot "app\src\main\res\mipmap-xxxhdpi\ic_launcher.png"
    if (Test-Path $AndroidIcon) {
        Copy-Item $AndroidIcon $IconPath -Force
    } else {
        throw "Missing tizen/app/icon.png"
    }
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

Write-Host "==> Packaging Tizen .wgt..." -ForegroundColor Cyan
$PkgArgs = @("package", "-t", "wgt", "-o", $DistDir)
if ($Profile -ne "") {
    $PkgArgs += @("-s", $Profile)
}
$PkgArgs += @("--", $AppDir)

& tizen @PkgArgs
if ($LASTEXITCODE -ne 0) { throw "tizen package failed." }

$WgtFile = Get-ChildItem -Path $DistDir -Filter "*.wgt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $WgtFile) { throw "No .wgt file produced in $DistDir" }
Write-Host "==> Built signed package: $($WgtFile.FullName)" -ForegroundColor Green

if ($TvIp -ne "") {
    Write-Host "==> Connecting to Samsung TV at $TvIp..." -ForegroundColor Cyan
    & sdb connect "${TvIp}:26101"
    $DevLine = (& sdb devices | Select-String -Pattern ([regex]::Escape("${TvIp}:26101")) | Select-Object -First 1).ToString()
    $TargetName = ($DevLine -split "\s+")[-1]
    if (-not $TargetName) { $TargetName = "${TvIp}:26101" }
    Write-Host "==> Installing $($WgtFile.Name) to target $TargetName..." -ForegroundColor Cyan
    & tizen install -n $WgtFile.Name -t $TargetName -- $DistDir
    if ($LASTEXITCODE -ne 0) { throw "tizen install failed." }
    Write-Host "==> Installed Nightjar on Samsung TV ($TargetName / $TvIp)!" -ForegroundColor Green
}
