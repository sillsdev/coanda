# Prints, as a JSON array, the visible top-level windows that match: $env:HOWBENCH_HWND, or those
# of process $env:HOWBENCH_PID whose title matches the regular expression $env:HOWBENCH_TITLE (either
# may be left out). With $env:HOWBENCH_TIMEOUT_MS, waits up to that long for one to appear, then
# exits 1 with an empty array. Topmost first.
. "$PSScriptRoot\common.ps1"
$timeout = [int]$env:HOWBENCH_TIMEOUT_MS
$clock = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
    $hits = @(Get-TargetWindows)
    if ($hits.Count -or $clock.ElapsedMilliseconds -ge $timeout) { break }
    Start-Sleep -Milliseconds 250
}
Write-Json @($hits)
if (-not $hits.Count -and $timeout) { exit 1 }
