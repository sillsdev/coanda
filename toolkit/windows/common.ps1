# Win32 calls shared by the helpers in this folder, which dot-source it. Nothing here sends a
# message to another app's windows, activates a window or moves the mouse: EnumWindows and
# GetWindowText on another process read cached state, so polling them never keeps an app's
# message queue busy (UI Automation queries can starve a WinForms dialog that opens "when idle").
#
# The process is made per-monitor DPI aware first, so every rectangle is in physical screen
# pixels, the pixels ffmpeg captures and UI Automation reports.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

if (-not ('CoandaWin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CoandaWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);

    /** Visible top-level windows, topmost first. */
    public static List<IntPtr> TopLevel() {
        var all = new List<IntPtr>();
        EnumWindows((h, l) => { if (IsWindowVisible(h)) all.Add(h); return true; }, IntPtr.Zero);
        return all;
    }

    public static string Title(IntPtr h) {
        var s = new StringBuilder(512);
        GetWindowText(h, s, s.Capacity);
        return s.ToString();
    }

    public static string ClassName(IntPtr h) {
        var s = new StringBuilder(256);
        GetClassName(h, s, s.Capacity);
        return s.ToString();
    }

    public static int ProcessId(IntPtr h) {
        int pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    /** The window as it looks on screen, without the invisible resize borders GetWindowRect counts. */
    public static RECT Frame(IntPtr h) {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
        return r;
    }

    public static RECT Client(IntPtr h) {
        RECT c;
        GetClientRect(h, out c);
        var p = new POINT();
        ClientToScreen(h, ref p);
        return new RECT { Left = p.X, Top = p.Y, Right = p.X + c.Right, Bottom = p.Y + c.Bottom };
    }

    /** The DPI of the screen the window is mostly on: 96 at 100%, 120 at 125%. */
    public static uint MonitorDpi(IntPtr h) {
        uint x, y;
        return GetDpiForMonitor(MonitorFromWindow(h, 2), 0, out x, out y) == 0 ? x : 96;
    }

    /** True for a window Windows keeps but doesn't draw, such as one on another virtual desktop. */
    public static bool Cloaked(IntPtr h) {
        int v;
        return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0;
    }

    public static bool Overlap(RECT a, RECT b) {
        return a.Left < b.Right && b.Left < a.Right && a.Top < b.Bottom && b.Top < a.Bottom;
    }
}

[ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIFactory {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int EnumAdapters(uint index, out IDXGIAdapter adapter);
}

[ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIAdapter {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DXGI_OUTPUT_DESC {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public CoandaWin.RECT DesktopCoordinates;
    public int AttachedToDesktop;
    public int Rotation;
    public IntPtr Monitor;
}

[ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDXGIOutput {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    [PreserveSig] int GetDesc(out DXGI_OUTPUT_DESC desc);
}

public static class CoandaDxgi {
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

    /** The outputs of the first graphics adapter, in the order ffmpeg's ddagrab numbers them. */
    public static List<DXGI_OUTPUT_DESC> Outputs() {
        var guid = typeof(IDXGIFactory).GUID;
        object o;
        Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref guid, out o));
        var factory = (IDXGIFactory)o;
        var list = new List<DXGI_OUTPUT_DESC>();
        IDXGIAdapter adapter;
        if (factory.EnumAdapters(0, out adapter) != 0) return list;
        IDXGIOutput output;
        for (uint i = 0; adapter.EnumOutputs(i, out output) == 0; i++) {
            DXGI_OUTPUT_DESC d;
            output.GetDesc(out d);
            list.Add(d);
        }
        return list;
    }
}
'@
}

# Per-monitor aware (v2). Fails harmlessly if the process's awareness is already set.
[CoandaWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

function ConvertTo-Box($r) {
    [ordered]@{ x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
}

# What the TypeScript side reads about a window, including the visible windows above it that
# overlap it, or overlap $env:COANDA_AREA ("x,y,width,height") if set: anything there would be
# in a screen recording of it.
function Get-WindowInfo([IntPtr]$h, [System.Collections.Generic.List[IntPtr]]$zOrder) {
    $frame = [CoandaWin]::Frame($h)
    $area = $frame
    if ($env:COANDA_AREA) {
        $x, $y, $w, $ht = $env:COANDA_AREA.Split(',') | ForEach-Object { [int]$_ }
        $area = New-Object CoandaWin+RECT
        $area.Left = $x; $area.Top = $y; $area.Right = $x + $w; $area.Bottom = $y + $ht
    }
    $windowPid = [CoandaWin]::ProcessId($h)
    $above = @()
    foreach ($other in $zOrder) {
        if ($other -eq $h) { break }
        if ([CoandaWin]::Cloaked($other)) { continue }
        $r = [CoandaWin]::Frame($other)
        if ($r.Right -le $r.Left -or $r.Bottom -le $r.Top -or -not [CoandaWin]::Overlap($r, $area)) { continue }
        $otherPid = [CoandaWin]::ProcessId($other)
        $name = try { (Get-Process -Id $otherPid).ProcessName } catch { '' }
        $above += [ordered]@{ pid = $otherPid; process = $name; className = [CoandaWin]::ClassName($other); frame = ConvertTo-Box $r }
    }
    [ordered]@{
        hwnd = $h.ToInt64()
        pid = $windowPid
        title = [CoandaWin]::Title($h)
        className = [CoandaWin]::ClassName($h)
        frame = ConvertTo-Box $frame
        client = ConvertTo-Box ([CoandaWin]::Client($h))
        dpi = [CoandaWin]::MonitorDpi($h)
        minimized = [CoandaWin]::IsIconic($h)
        cloaked = [CoandaWin]::Cloaked($h)
        foreground = [CoandaWin]::GetForegroundWindow() -eq $h
        above = @($above)
    }
}

function Get-TargetWindows {
    $zOrder = [CoandaWin]::TopLevel()
    $hits = @()
    if ($env:COANDA_HWND) {
        $h = [IntPtr][int64]$env:COANDA_HWND
        if (-not [CoandaWin]::IsWindow($h)) { throw "No window $($env:COANDA_HWND)" }
        return @(Get-WindowInfo $h $zOrder)
    }
    foreach ($h in $zOrder) {
        if ($env:COANDA_PID -and [CoandaWin]::ProcessId($h) -ne [int]$env:COANDA_PID) { continue }
        if ($env:COANDA_TITLE -and -not ([CoandaWin]::Title($h) -match $env:COANDA_TITLE)) { continue }
        $hits += , (Get-WindowInfo $h $zOrder)
    }
    return @($hits)
}

function Write-Json($value) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Depth 6 -Compress))
}
