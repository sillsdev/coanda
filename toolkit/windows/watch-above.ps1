# Prints a JSON line with the windows above window $env:COANDA_HWND that overlap it (or
# $env:COANDA_AREA, "x,y,width,height") at the start and each time that set changes, checking
# every $env:COANDA_INTERVAL_MS (default 200). Runs until killed, until process
# $env:COANDA_PARENT_PID ends, or until the window goes away, which it reports with "gone".
. "$PSScriptRoot\common.ps1"
$h = [IntPtr][int64]$env:COANDA_HWND
$interval = if ($env:COANDA_INTERVAL_MS) { [int]$env:COANDA_INTERVAL_MS } else { 200 }
$parent = if ($env:COANDA_PARENT_PID) { Get-Process -Id ([int]$env:COANDA_PARENT_PID) } else { $null }
$last = $null
while ($true) {
    $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000
    if (-not [CoandaWin]::IsWindow($h)) {
        Write-Json ([ordered]@{ t = $t; above = @(); minimized = $false; gone = $true })
        break
    }
    if ($parent -and $parent.HasExited) { break }
    $info = Get-WindowInfo $h ([CoandaWin]::TopLevel())
    $now = ConvertTo-Json -InputObject @($info.above, $info.minimized) -Depth 6 -Compress
    if ($now -ne $last) {
        Write-Json ([ordered]@{ t = $t; above = @($info.above); minimized = $info.minimized; gone = $false })
        $last = $now
    }
    Start-Sleep -Milliseconds $interval
}
