# Brings window $env:HOWBENCH_HWND to the front and gives it the focus, un-minimizing it first.
# Only for a recording the person has agreed to: it takes the screen from them. Windows lets a
# background process take the foreground only right after a key event, so this sends a press
# and release of Alt first, which apps ignore on their own.
. "$PSScriptRoot\common.ps1"
$h = [IntPtr][int64]$env:HOWBENCH_HWND
if (-not [HowBenchWin]::IsWindow($h)) { throw "No window $($env:HOWBENCH_HWND)" }
$VK_MENU = 0x12; $KEYEVENTF_KEYUP = 2
[HowBenchWin]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
[HowBenchWin]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
[HowBenchWin]::ShowWindow($h, $(if ([HowBenchWin]::IsIconic($h)) { 9 } else { 5 })) | Out-Null
[HowBenchWin]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
Write-Json (Get-WindowInfo $h ([HowBenchWin]::TopLevel()))
