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
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $PSScriptRoot "app"
$DistDir = Join-Path $PSScriptRoot "dist"

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
