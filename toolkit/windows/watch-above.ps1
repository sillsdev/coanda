# Prints a JSON line with the windows above window $env:HOWBENCH_HWND that overlap it (or
# $env:HOWBENCH_AREA, "x,y,width,height") at the start and each time that set changes, checking
# every $env:HOWBENCH_INTERVAL_MS (default 200). Runs until killed, until process
# $env:HOWBENCH_PARENT_PID ends, or until the window goes away, which it reports with "gone".
. "$PSScriptRoot\common.ps1"
$h = [IntPtr][int64]$env:HOWBENCH_HWND
$interval = if ($env:HOWBENCH_INTERVAL_MS) { [int]$env:HOWBENCH_INTERVAL_MS } else { 200 }
$parent = if ($env:HOWBENCH_PARENT_PID) { Get-Process -Id ([int]$env:HOWBENCH_PARENT_PID) } else { $null }
$last = $null
while ($true) {
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000
    if (-not [HowBenchWin]::IsWindow($h)) {
        Write-Json ([ordered]@{ t = $t; above = @(); minimized = $false; gone = $true })
        break
    }
    if ($parent -and $parent.HasExited) { break }
    $info = Get-WindowInfo $h ([HowBenchWin]::TopLevel())
    $now = ConvertTo-Json -InputObject @($info.above, $info.minimized) -Depth 6 -Compress
    if ($now -ne $last) {
        Write-Json ([ordered]@{ t = $t; above = @($info.above); minimized = $info.minimized; gone = $false })
        $last = $now
    }
    Start-Sleep -Milliseconds $interval
}
