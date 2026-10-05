# Puts windows behind every other window without activating them, un-minimizing them first:
# window $env:HOWBENCH_HWND, or every visible top-level window of process $env:HOWBENCH_PID (its main
# window and dialogs). The app still draws, and CDP and UI Automation still reach it, while the
# person works in front of it.
#
# With $env:HOWBENCH_CLIENT_RECT ("x,y,width,height", physical screen pixels) and one window, also
# moves and sizes the window so its client area (the inside, without title bar or borders) is
# exactly there.
. "$PSScriptRoot\common.ps1"
$SW_SHOWNOACTIVATE = 4
$HWND_BOTTOM = [IntPtr]1
$SWP_NOSIZE = 0x1; $SWP_NOMOVE = 0x2; $SWP_NOACTIVATE = 0x10

$windows = if ($env:HOWBENCH_HWND) { @([IntPtr][int64]$env:HOWBENCH_HWND) } else {
    @([HowBenchWin]::TopLevel() | Where-Object { [HowBenchWin]::ProcessId($_) -eq [int]$env:HOWBENCH_PID })
}
if (-not $windows.Count) { throw 'No window to put behind' }
foreach ($h in $windows) {
    if ([HowBenchWin]::IsIconic($h)) { [HowBenchWin]::ShowWindow($h, $SW_SHOWNOACTIVATE) | Out-Null }
    [HowBenchWin]::SetWindowPos($h, $HWND_BOTTOM, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE) | Out-Null
}
if ($env:HOWBENCH_CLIENT_RECT) {
    if ($windows.Count -ne 1) { throw 'HOWBENCH_CLIENT_RECT needs exactly one window' }
    $h = $windows[0]
    $x, $y, $w, $ht = $env:HOWBENCH_CLIENT_RECT.Split(',') | ForEach-Object { [int]$_ }
    # Two passes: the first can move the window to a monitor with another DPI, which changes
    # the borders.
    foreach ($pass in 1, 2) {
        $outer = New-Object HowBenchWin+RECT
        [HowBenchWin]::GetWindowRect($h, [ref]$outer) | Out-Null
        $inner = [HowBenchWin]::Client($h)
        $left = $inner.Left - $outer.Left; $top = $inner.Top - $outer.Top
        $right = $outer.Right - $inner.Right; $bottom = $outer.Bottom - $inner.Bottom
        [HowBenchWin]::SetWindowPos($h, $HWND_BOTTOM, $x - $left, $y - $top, $w + $left + $right, $ht + $top + $bottom, $SWP_NOACTIVATE) | Out-Null
    }
}
Write-Json @($windows | ForEach-Object { Get-WindowInfo $_ ([HowBenchWin]::TopLevel()) })
