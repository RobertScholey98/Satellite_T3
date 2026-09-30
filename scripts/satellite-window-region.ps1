param(
  [Parameter(Mandatory = $true)]
  [long]$OwnedHwnd
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OwnedWindowRegionInspector {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern int GetRgnBox(IntPtr region, out RECT bounds);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern bool DeleteObject(IntPtr value);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    public static extern int GetWindowLong32(IntPtr hwnd, int index);

    public static long ExtendedStyle(IntPtr hwnd) {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
    }
}
'@

$windowHandle = [IntPtr]::new($OwnedHwnd)
if (-not [OwnedWindowRegionInspector]::IsWindow($windowHandle)) {
  throw 'OwnedHwnd must identify a live test window.'
}

$previousDpiContext = [OwnedWindowRegionInspector]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$region = [OwnedWindowRegionInspector]::CreateRectRgn(0, 0, 0, 0)
if ($region -eq [IntPtr]::Zero) {
  if ($previousDpiContext -ne [IntPtr]::Zero) {
    $null = [OwnedWindowRegionInspector]::SetThreadDpiAwarenessContext($previousDpiContext)
  }
  throw 'Could not allocate a temporary region.'
}

try {
  $regionType = [OwnedWindowRegionInspector]::GetWindowRgn($windowHandle, $region)
  $rectangle = New-Object OwnedWindowRegionInspector+RECT
  $boxType = if ($regionType -ne 0) {
    [OwnedWindowRegionInspector]::GetRgnBox($region, [ref]$rectangle)
  } else { 0 }
  $style = [OwnedWindowRegionInspector]::ExtendedStyle($windowHandle)
  $bounds = if ($boxType -ne 0) {
    @{
      x = $rectangle.Left
      y = $rectangle.Top
      width = $rectangle.Right - $rectangle.Left
      height = $rectangle.Bottom - $rectangle.Top
    }
  } else { $null }
  @{
    regionType = $regionType
    boxType = $boxType
    bounds = $bounds
    extendedStyle = $style
    toolWindow = ($style -band 0x00000080) -ne 0
    appWindow = ($style -band 0x00040000) -ne 0
  } | ConvertTo-Json -Compress
} finally {
  $null = [OwnedWindowRegionInspector]::DeleteObject($region)
  if ($previousDpiContext -ne [IntPtr]::Zero) {
    $null = [OwnedWindowRegionInspector]::SetThreadDpiAwarenessContext($previousDpiContext)
  }
}
