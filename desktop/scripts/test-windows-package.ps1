# Runs in an isolated Windows runner/user profile, never against user meetings.
$ErrorActionPreference = 'Stop'
$installer = Get-ChildItem './src-tauri/target/release/bundle/nsis/*-setup.exe' | Select-Object -First 1
if (-not $installer) { throw 'Installer missing' }
$installDir = Join-Path $env:RUNNER_TEMP 'MeetingAI-package-test'
$setup = Start-Process $installer.FullName -ArgumentList @('/S', "/D=$installDir") -PassThru -Wait
if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
$exe = Join-Path $installDir 'meetingai.exe'
if (-not (Test-Path $exe)) { throw "Installed executable missing: $exe" }
if (Get-ChildItem $installDir -Recurse -Filter 'system-audio*.exe') { throw 'Unexpected audio helper in Rust Windows package' }
$first = $null
$second = $null
try {
    $first = Start-Process $exe -PassThru
    for ($i=0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        $first.Refresh()
        if ($first.HasExited) { throw "App exited before rendering: $($first.ExitCode)" }
        if ($first.MainWindowHandle -ne 0) { break }
    }
    if ($first.MainWindowHandle -eq 0) { throw 'Main window did not appear' }
    $second = Start-Process $exe -PassThru
    if (-not $second.WaitForExit(10000)) { throw 'Second app instance did not exit' }
    $first.Refresh()
    if ($first.HasExited) { throw 'Primary app exited during duplicate launch' }
    $instances = @(Get-Process meetingai -ErrorAction SilentlyContinue)
    if ($instances.Count -ne 1) { throw "Expected one MeetingAI process, found $($instances.Count)" }
    Write-Host 'PASS: installer, native window, duplicate launch, and no separate audio helper.'
} finally {
    foreach ($process in @($second,$first)) {
        if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    }
}
