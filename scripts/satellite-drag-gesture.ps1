param(
  [Parameter(Mandatory = $true)][long]$OwnedHwnd,
  [Parameter(Mandatory = $true)][int]$StartX,
  [Parameter(Mandatory = $true)][int]$StartY,
  [Parameter(Mandatory = $true)][int]$EndX,
  [Parameter(Mandatory = $true)][int]$EndY,
  [int]$Steps = 12,
  [int]$StepDelayMs = 20,
  [switch]$WaitForPressAcknowledgement,
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
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr region, out RECT rect);
    [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong32(IntPtr hwnd, int index);
    public static long ExtendedStyle(IntPtr hwnd) {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
    }
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
  $hitWindow = [SatelliteOwnedDrag]::WindowFromPoint($startPoint)
  $hitRoot = [SatelliteOwnedDrag]::GetAncestor($hitWindow, 2)
  if ($hitRoot -ne $windowHandle) {
    $ownedRect = New-Object SatelliteOwnedDrag+RECT
    $haveOwnedRect = [SatelliteOwnedDrag]::GetWindowRect($windowHandle, [ref]$ownedRect)
    $hitRect = New-Object SatelliteOwnedDrag+RECT
    $haveHitRect = $hitRoot -ne [IntPtr]::Zero -and [SatelliteOwnedDrag]::GetWindowRect($hitRoot, [ref]$hitRect)
    $ownedProcessId = [uint32]0
    $hitProcessId = [uint32]0
    $null = [SatelliteOwnedDrag]::GetWindowThreadProcessId($windowHandle, [ref]$ownedProcessId)
    if ($hitRoot -ne [IntPtr]::Zero) { $null = [SatelliteOwnedDrag]::GetWindowThreadProcessId($hitRoot, [ref]$hitProcessId) }
    $region = [SatelliteOwnedDrag]::CreateRectRgn(0, 0, 0, 0)
    $regionType = 0
    $regionBounds = $null
    $insideRegion = $null
    try {
      if ($region -ne [IntPtr]::Zero) {
        $regionType = [SatelliteOwnedDrag]::GetWindowRgn($windowHandle, $region)
        if ($regionType -ne 0) {
          $regionRect = New-Object SatelliteOwnedDrag+RECT
          $null = [SatelliteOwnedDrag]::GetRgnBox($region, [ref]$regionRect)
          $regionBounds = @{ x = $regionRect.Left; y = $regionRect.Top; width = $regionRect.Right - $regionRect.Left; height = $regionRect.Bottom - $regionRect.Top }
          if ($haveOwnedRect) { $insideRegion = [SatelliteOwnedDrag]::PtInRegion($region, $startPoint.X - $ownedRect.Left, $startPoint.Y - $ownedRect.Top) }
        }
      }
    } finally {
      if ($region -ne [IntPtr]::Zero) { $null = [SatelliteOwnedDrag]::DeleteObject($region) }
    }
    $style = [SatelliteOwnedDrag]::ExtendedStyle($windowHandle)
    $diagnostic = @{
      ownedHwnd = $OwnedHwnd
      hitHwnd = $hitWindow.ToInt64()
      hitRootHwnd = $hitRoot.ToInt64()
      foregroundHwnd = [SatelliteOwnedDrag]::GetForegroundWindow().ToInt64()
      ownedProcessId = $ownedProcessId
      hitProcessId = $hitProcessId
      requestedPoint = @{ x = $StartX; y = $StartY }
      actualPoint = @{ x = $startPoint.X; y = $startPoint.Y }
      localPhysicalPoint = if ($haveOwnedRect) { @{ x = $startPoint.X - $ownedRect.Left; y = $startPoint.Y - $ownedRect.Top } } else { $null }
      ownedPhysicalBounds = if ($haveOwnedRect) { @{ x = $ownedRect.Left; y = $ownedRect.Top; width = $ownedRect.Right - $ownedRect.Left; height = $ownedRect.Bottom - $ownedRect.Top } } else { $null }
      hitRootPhysicalBounds = if ($haveHitRect) { @{ x = $hitRect.Left; y = $hitRect.Top; width = $hitRect.Right - $hitRect.Left; height = $hitRect.Bottom - $hitRect.Top } } else { $null }
      ownedVisible = [SatelliteOwnedDrag]::IsWindowVisible($windowHandle)
      ownedEnabled = [SatelliteOwnedDrag]::IsWindowEnabled($windowHandle)
      ownedDpi = [SatelliteOwnedDrag]::GetDpiForWindow($windowHandle)
      regionType = $regionType
      regionBounds = $regionBounds
      pointInsideRegion = $insideRegion
      extendedStyle = $style
      transparentStyle = ($style -band 0x00000020) -ne 0
      layeredStyle = ($style -band 0x00080000) -ne 0
    }
    [Console]::Error.WriteLine('[satellite-drag-guard] ' + ($diagnostic | ConvertTo-Json -Depth 4 -Compress))
    throw 'The drag start does not belong to OwnedHwnd; no button was pressed.'
  }
  $buttonPressed = $true
  [SatelliteOwnedDrag]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  if ($WaitForPressAcknowledgement) {
    [Console]::Out.WriteLine('[satellite-drag-pressed]')
    [Console]::Out.Flush()
    $pressAcknowledgement = [Console]::In.ReadLineAsync()
    if (-not $pressAcknowledgement.Wait(5000) -or $pressAcknowledgement.Result -ne 'pressed') {
      throw 'The renderer did not acknowledge pointerdown; no drag movement was sent.'
    }
  }
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
