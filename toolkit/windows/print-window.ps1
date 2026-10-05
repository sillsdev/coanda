# Saves a PNG of window $env:HOWBENCH_HWND at $env:HOWBENCH_OUT, even when other windows cover it,
# with PrintWindow's PW_RENDERFULLCONTENT, which also gets what Chromium and WPF draw on the
# GPU. With $env:HOWBENCH_CLIENT = 1, only the client area (no title bar or borders). The window
# must not be minimized. The image is in the window's own pixels: a window that isn't DPI aware
# comes out at its unscaled size, smaller than it looks on a scaled screen.
. "$PSScriptRoot\common.ps1"
Add-Type -AssemblyName System.Drawing
$h = [IntPtr][int64]$env:HOWBENCH_HWND
if (-not [HowBenchWin]::IsWindow($h)) { throw "No window $($env:HOWBENCH_HWND)" }
if ([HowBenchWin]::IsIconic($h)) { throw 'The window is minimized: put it behind other windows first' }
# The visible frame inside the invisible resize borders, which DWM gives only in physical pixels.
$physical = New-Object HowBenchWin+RECT
[HowBenchWin]::GetWindowRect($h, [ref]$physical) | Out-Null
$frame = [HowBenchWin]::Frame($h)
# Measure and print as the window sees itself, or PrintWindow fills only part of the bitmap.
[HowBenchWin]::SetThreadDpiAwarenessContext([HowBenchWin]::GetWindowDpiAwarenessContext($h)) | Out-Null
$client = $env:HOWBENCH_CLIENT -eq '1'
$outer = New-Object HowBenchWin+RECT
[HowBenchWin]::GetWindowRect($h, [ref]$outer) | Out-Null
$area = if ($client) { [HowBenchWin]::Client($h) } else { $outer }
$bitmap = New-Object System.Drawing.Bitmap ($area.Right - $area.Left), ($area.Bottom - $area.Top)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
$ok = [HowBenchWin]::PrintWindow($h, $dc, $(if ($client) { 3 } else { 2 }))
$graphics.ReleaseHdc($dc)
if (-not $ok) { throw 'PrintWindow failed' }
if (-not $client) {
    # Leave out the invisible resize borders GetWindowRect counts.
    $k = ($outer.Right - $outer.Left) / ($physical.Right - $physical.Left)
    $left = [int](($frame.Left - $physical.Left) * $k); $top = [int](($frame.Top - $physical.Top) * $k)
    $right = [int](($physical.Right - $frame.Right) * $k); $bottom = [int](($physical.Bottom - $frame.Bottom) * $k)
    $crop = New-Object System.Drawing.Rectangle $left, $top, ($bitmap.Width - $left - $right), ($bitmap.Height - $top - $bottom)
    $cropped = $bitmap.Clone($crop, $bitmap.PixelFormat)
    $bitmap.Dispose()
    $bitmap = $cropped
}
$bitmap.Save($env:HOWBENCH_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Json ([ordered]@{ file = $env:HOWBENCH_OUT; width = $bitmap.Width; height = $bitmap.Height })
