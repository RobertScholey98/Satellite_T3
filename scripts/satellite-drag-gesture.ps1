param(
  [Parameter(Mandatory = $true)][long]$OwnedHwnd,
  [Parameter(Mandatory = $true)][int]$StartX,
  [Parameter(Mandatory = $true)][int]$StartY,
  [Parameter(Mandatory = $true)][int]$EndX,
  [Parameter(Mandatory = $true)][int]$EndY,
  [int]$Steps = 12,
  [int]$StepDelayMs = 20,
  [switch]$WaitForReleaseAcknowledgement
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SatelliteOwnedDrag {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$windowHandle = [IntPtr]::new($OwnedHwnd)
if (-not [SatelliteOwnedDrag]::IsWindow($windowHandle)) { throw 'OwnedHwnd is not a live test window.' }
if (([SatelliteOwnedDrag]::GetAsyncKeyState(1) -band 0x8000) -ne 0) { throw 'The left mouse button is already held.' }
$previousDpiContext = [SatelliteOwnedDrag]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
if ($previousDpiContext -eq [IntPtr]::Zero) { throw 'Could not establish physical-pixel coordinates.' }
$originalCursor = New-Object SatelliteOwnedDrag+POINT
$haveOriginalCursor = $false
$buttonPressed = $false
try {
  $haveOriginalCursor = [SatelliteOwnedDrag]::GetCursorPos([ref]$originalCursor)
  if (-not $haveOriginalCursor) { throw 'Could not read the original cursor position.' }
  if (-not [SatelliteOwnedDrag]::SetCursorPos($StartX, $StartY)) { throw 'Could not move to the drag start.' }
  $startPoint = New-Object SatelliteOwnedDrag+POINT
  if (-not [SatelliteOwnedDrag]::GetCursorPos([ref]$startPoint)) { throw 'Could not verify the drag start.' }
  if ($startPoint.X -ne $StartX -or $startPoint.Y -ne $StartY) { throw 'The requested drag start is outside the available desktop.' }
  $hitRoot = [SatelliteOwnedDrag]::GetAncestor([SatelliteOwnedDrag]::WindowFromPoint($startPoint), 2)
  if ($hitRoot -ne $windowHandle) { throw 'The drag start does not belong to OwnedHwnd; no button was pressed.' }
  $buttonPressed = $true
  [SatelliteOwnedDrag]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  $samples = [System.Collections.Generic.List[object]]::new()
  for ($step = 1; $step -le $Steps; $step++) {
    if (-not [SatelliteOwnedDrag]::IsWindow($windowHandle)) { throw 'The owned test window closed during the drag.' }
    $x = [int][Math]::Round($StartX + ($EndX - $StartX) * $step / $Steps)
    $y = [int][Math]::Round($StartY + ($EndY - $StartY) * $step / $Steps)
    if (-not [SatelliteOwnedDrag]::SetCursorPos($x, $y)) { throw 'Could not move the cursor during the drag.' }
    Start-Sleep -Milliseconds $StepDelayMs
    $rect = New-Object SatelliteOwnedDrag+RECT
    if (-not [SatelliteOwnedDrag]::GetWindowRect($windowHandle, [ref]$rect)) { throw 'Could not sample the owned window.' }
    $samples.Add(@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top; dpi = [SatelliteOwnedDrag]::GetDpiForWindow($windowHandle) })
  }
  [SatelliteOwnedDrag]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  $buttonPressed = $false
  @{ ownedHwnd = $OwnedHwnd; validatedRootHwnd = $hitRoot.ToInt64(); start = @($StartX, $StartY); end = @($EndX, $EndY); steps = $Steps; samples = $samples } | ConvertTo-Json -Depth 4 -Compress
  if ($WaitForReleaseAcknowledgement) {
    $null = [Console]::In.ReadLineAsync().Wait(5000)
  }
} finally {
  if ($buttonPressed) { [SatelliteOwnedDrag]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
  if ($haveOriginalCursor) { $null = [SatelliteOwnedDrag]::SetCursorPos($originalCursor.X, $originalCursor.Y) }
  $null = [SatelliteOwnedDrag]::SetThreadDpiAwarenessContext($previousDpiContext)
}
