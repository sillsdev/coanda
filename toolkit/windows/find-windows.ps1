# Prints, as a JSON array, the visible top-level windows that match: $env:COANDA_HWND, or those
# of process $env:COANDA_PID whose title matches the regular expression $env:COANDA_TITLE (either
# may be left out). With $env:COANDA_TIMEOUT_MS, waits up to that long for one to appear, then
# exits 1 with an empty array. Topmost first.
. "$PSScriptRoot\common.ps1"
$timeout = [int]$env:COANDA_TIMEOUT_MS
$clock = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
    $hits = @(Get-TargetWindows)
    if ($hits.Count -or $clock.ElapsedMilliseconds -ge $timeout) { break }
    Start-Sleep -Milliseconds 250
}
Write-Json @($hits)
if (-not $hits.Count -and $timeout) { exit 1 }
