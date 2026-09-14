param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    throw "The Windows sidecar must be compiled on Windows."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Split-Path -Parent $scriptDir
$source = Join-Path $desktopDir "sidecar-windows\system-audio.cpp"
$outputDir = Join-Path $desktopDir "src-tauri\binaries"
$output = Join-Path $outputDir "system-audio-$TargetTriple.exe"
$objectDir = Join-Path $env:TEMP "meetingai-sidecar"

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe was not found. Run this from an MSVC developer shell or use the Windows release workflow."
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
New-Item -ItemType Directory -Path $objectDir -Force | Out-Null

& cl.exe `
    /nologo `
    /std:c++17 `
    /O2 `
    /EHsc `
    /W4 `
    /WX `
    /DUNICODE `
    /D_UNICODE `
    "/Fo$objectDir\" `
    "/Fe$output" `
    $source `
    /link `
    Ole32.lib `
    Mmdevapi.lib `
    Uuid.lib

if ($LASTEXITCODE -ne 0) {
    throw "Windows system-audio sidecar compilation failed with exit code $LASTEXITCODE."
}

& $output --help | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "The Windows system-audio sidecar smoke check failed."
}

Write-Host "Windows sidecar installed: $output"
