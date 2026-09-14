param(
    [Parameter(Mandatory = $true)]
    [string]$File
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $env:WINDOWS_CERTIFICATE_SHA1) {
    throw "WINDOWS_CERTIFICATE_SHA1 is required. Refusing to produce an unsigned release."
}

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signTool) {
    $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    $signTool = Get-ChildItem -Path $kitsRoot -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
}
if (-not $signTool) {
    throw "signtool.exe was not found in PATH or the Windows SDK."
}

$signToolPath = if ($signTool -is [System.Management.Automation.CommandInfo]) {
    $signTool.Source
} else {
    $signTool.FullName
}
& $signToolPath sign `
    /sha1 $env:WINDOWS_CERTIFICATE_SHA1 `
    /fd SHA256 `
    /tr "http://timestamp.digicert.com" `
    /td SHA256 `
    /d "MeetingAI" `
    $File
if ($LASTEXITCODE -ne 0) {
    throw "Authenticode signing failed for $File."
}

& $signToolPath verify /pa /all $File
if ($LASTEXITCODE -ne 0) {
    throw "Authenticode verification failed for $File."
}
