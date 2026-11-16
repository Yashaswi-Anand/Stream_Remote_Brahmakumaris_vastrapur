# Zoom Stream Automation - Windows UI Automation helper.
# Long-running process: reads one JSON request per line on stdin and writes one JSON response per line on stdout.
# Request:  {"id":1,"cmd":"click","args":{...}}
# Response: {"id":1,"ok":true,"result":{...}} or {"id":1,"ok":false,"error":"..."}

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

if (-not ('ZsaWin32' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ZsaWin32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

  // Moves (and if needed shrinks) a window so it lies fully inside the given work area. Returns true if it moved.
  public static bool FitInto(IntPtr h, int l, int t, int r, int b) {
    RECT w; if (!GetWindowRect(h, out w)) return false;
    int cw = Math.Min(w.Right - w.Left, r - l), ch = Math.Min(w.Bottom - w.Top, b - t);
    int x = Math.Max(l, Math.Min(w.Left, r - cw)), y = Math.Max(t, Math.Min(w.Top, b - ch));
    if (x == w.Left && y == w.Top && cw == w.Right - w.Left && ch == w.Bottom - w.Top) return false;
    return SetWindowPos(h, IntPtr.Zero, x, y, cw, ch, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public class WinInfo {
    public long Hwnd; public uint Pid; public string Title; public string Cls;
    public bool Visible; public bool Minimized; public int Left, Top, Right, Bottom;
  }

  public static List<WinInfo> List(HashSet<uint> pids) {
    var list = new List<WinInfo>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid)) {
        var t = new StringBuilder(512); GetWindowText(h, t, 512);
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        RECT r; GetWindowRect(h, out r);
        list.Add(new WinInfo { Hwnd = h.ToInt64(), Pid = pid, Title = t.ToString(), Cls = c.ToString(),
          Visible = IsWindowVisible(h), Minimized = IsIconic(h), Left = r.Left, Top = r.Top, Right = r.Right, Bottom = r.Bottom });
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    // A synthetic Alt tap lets a background process move the foreground window.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    if (GetForegroundWindow() != h) {
      // Windows refused (another app, e.g. a browser, was just opened): join its input queue and try again.
      uint pid;
      uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      uint me = GetCurrentThreadId();
      bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      if (attached) AttachThreadInput(me, fg, false);
    }
    // Always raise it above other windows (allowed even when focus is refused), so what is read on screen is this window.
    const uint flags = 0x0001 | 0x0002 | 0x0040; // NOSIZE | NOMOVE | SHOWWINDOW
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, flags); // topmost
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, flags); // back to normal, staying on top
    return GetForegroundWindow() == h;
  }

  /** Mouse wheel over a point (negative = scroll down); the pointer is put straight back. */
  public static void Wheel(int x, int y, int clicks) {
    POINT before; GetCursorPos(out before);
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0800, 0, 0, (uint)(clicks * 120), UIntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    SetCursorPos(before.X, before.Y);
  }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);

  // true: clicks and hovers are sent as window messages, so the user's mouse pointer never moves.
  // false: a real click, with the pointer put straight back where it was.
  public static bool Background = true;

  static IntPtr Lp(POINT c) { return (IntPtr)(((c.Y & 0xFFFF) << 16) | (c.X & 0xFFFF)); }

  // Sends mouse messages to the window (or child control) under a screen point, without moving the cursor.
  public static bool PostMouse(int x, int y, bool click) {
    var pt = new POINT { X = x, Y = y };
    IntPtr h = WindowFromPoint(pt);
    if (h == IntPtr.Zero) return false;
    var c = pt;
    if (!ScreenToClient(h, ref c)) return false;
    IntPtr lp = Lp(c);
    PostMessage(h, 0x0200, IntPtr.Zero, lp); // WM_MOUSEMOVE
    if (click) {
      PostMessage(h, 0x0201, (IntPtr)1, lp); // WM_LBUTTONDOWN (MK_LBUTTON)
      PostMessage(h, 0x0202, IntPtr.Zero, lp); // WM_LBUTTONUP
    }
    return true;
  }

  public static void PhysicalClick(int x, int y) {
    POINT before; GetCursorPos(out before);
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    SetCursorPos(before.X, before.Y);
  }

  // Hover (e.g. to wake Zoom's auto-hiding toolbar).
  public static void MoveMouse(int x, int y) {
    if (Background && PostMouse(x, y, false)) return;
    SetCursorPos(x, y);
  }

  public static void Click(int x, int y) {
    if (Background && PostMouse(x, y, true)) return;
    PhysicalClick(x, y);
  }

  // Physical hover: move there, wait, then put the pointer back.
  public static void HoverAndReturn(int x, int y, int ms) {
    POINT before; GetCursorPos(out before);
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(ms);
    SetCursorPos(before.X, before.Y);
  }
}
"@
}

# Per-monitor DPI awareness: window rectangles, mouse positions and screen captures all use physical pixels,
# so captures for text recognition are sharp on scaled displays.
try { [void][ZsaWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
Add-Type -AssemblyName System.Drawing, System.Runtime.WindowsRuntime

$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$AnyCond = [System.Windows.Automation.Condition]::TrueCondition
$BrowserNames = @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi')

function Get-ScopePids([string]$scope) {
  $names = if ($scope -eq 'browser') { $BrowserNames } else { @('Zoom') }
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($n in $names) {
    foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) { [void]$set.Add([uint32]$p.Id) }
  }
  return ,$set
}

function Test-Match([string]$value, $pattern) {
  if ($null -eq $pattern -or "$pattern" -eq '') { return $true }
  return [regex]::IsMatch("$value", "$pattern", 'IgnoreCase')
}

# Visible top-level windows in scope, filtered by optional class/title regexes.
function Get-ScopeWindows($a) {
  $scope = if ($a.scope) { "$($a.scope)" } else { 'zoom' }
  $set = Get-ScopePids $scope
  if ($set.Count -eq 0) { return @() }
  $wins = [ZsaWin32]::List($set) | Where-Object { $_.Visible }
  if ($a.hwnd) { $wins = $wins | Where-Object { $_.Hwnd -eq [long]$a.hwnd } }
  if ($a.cls) { $wins = $wins | Where-Object { Test-Match $_.Cls $a.cls } }
  if ($a.title) { $wins = $wins | Where-Object { Test-Match $_.Title $a.title } }
  if ($a.excludeCls) { $wins = $wins | Where-Object { -not (Test-Match $_.Cls $a.excludeCls) } }
  return @($wins)
}

function Get-TypeCondition($types) {
  if (-not $types -or @($types).Count -eq 0) { return $AnyCond }
  $conds = @()
  foreach ($t in @($types)) {
    $ct = [System.Windows.Automation.ControlType]::$t
    if ($ct) { $conds += New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $ct) }
  }
  if ($conds.Count -eq 0) { return $AnyCond }
  if ($conds.Count -eq 1) { return $conds[0] }
  return New-Object System.Windows.Automation.OrCondition(, [System.Windows.Automation.Condition[]]$conds)
}

function Describe($el, $win) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  return [ordered]@{
    name = $c.Name
    type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    automationId = $c.AutomationId
    className = $c.ClassName
    enabled = $c.IsEnabled
    offscreen = $c.IsOffscreen
    rect = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
    windowHwnd = if ($win) { $win.Hwnd } else { $null }
    windowTitle = if ($win) { $win.Title } else { $null }
    windowClass = if ($win) { $win.Cls } else { $null }
  }
}

# Finds the first element whose Name matches one of the patterns (patterns are tried in priority order).
function Find-First($a) {
  $wins = Get-ScopeWindows $a
  $cond = Get-TypeCondition $a.types
  $patterns = @($a.patterns)
  $candidates = @()
  foreach ($w in $wins) {
    try { $root = $UIA::FromHandle([IntPtr]$w.Hwnd) } catch { continue }
    $els = @()
    try { $els = @($root.FindAll($Scope::Descendants, $cond)) } catch { }
    foreach ($el in $els) {
      try { $n = $el.Current.Name } catch { continue }
      if (-not $n) { continue }
      $candidates += [pscustomobject]@{ el = $el; win = $w; name = $n }
    }
  }
  foreach ($p in $patterns) {
    $hits = @($candidates | Where-Object { Test-Match $_.name $p })
    if ($a.excludeNames) { $hits = @($hits | Where-Object { -not (Test-Match $_.name $a.excludeNames) }) }
    if ($hits.Count -eq 0) { continue }
    $onscreen = @($hits | Where-Object { try { -not $_.el.Current.IsOffscreen } catch { $false } })
    if ($onscreen.Count -gt 0) { return $onscreen[0] }
    if (-not $a.onscreenOnly) { return $hits[0] }
  }
  return $null
}

function Wait-Find($a) {
  $timeout = if ($a.timeoutMs) { [int]$a.timeoutMs } else { 0 }
  $deadline = (Get-Date).AddMilliseconds($timeout)
  while ($true) {
    $hit = Find-First $a
    if ($hit) { return $hit }
    if ((Get-Date) -ge $deadline) { return $null }
    Start-Sleep -Milliseconds 300
  }
}

# Wakes hover-only UI at a point: window messages in background mode, otherwise a brief real hover.
function Hover-Point([int]$x, [int]$y, [int]$waitMs) {
  if ([ZsaWin32]::Background) {
    [ZsaWin32]::MoveMouse($x - 40, $y - 40); Start-Sleep -Milliseconds 80
    [ZsaWin32]::MoveMouse($x, $y); Start-Sleep -Milliseconds 80
    [ZsaWin32]::MoveMouse($x + 3, $y); Start-Sleep -Milliseconds $waitMs
  } else {
    [ZsaWin32]::HoverAndReturn($x, $y, $waitMs)
  }
}

function Click-Center($el) {
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0) { throw "Element '$($el.Current.Name)' has no clickable area." }
  [ZsaWin32]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  return 'mouse'
}

function Invoke-Element($el, [bool]$preferMouse) {
  if ($preferMouse) { return Click-Center $el }
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return 'select' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return 'toggle' }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); return 'expand' }
  return Click-Center $el
}

function Get-ToggleState($el) {
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
    return ($p.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On)
  }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
    return [bool]$p.Current.IsSelected
  }
  return $null
}

function Cmd-Windows($a) {
  $scope = if ($a.scope) { "$($a.scope)" } else { 'zoom' }
  $set = Get-ScopePids $scope
  if ($set.Count -eq 0) { return @{ running = $false; windows = @() } }
  $wins = @([ZsaWin32]::List($set) | Where-Object { $_.Visible -or $a.includeHidden } | ForEach-Object {
    [ordered]@{ hwnd = $_.Hwnd; pid = $_.Pid; title = $_.Title; cls = $_.Cls; visible = $_.Visible; minimized = $_.Minimized;
      rect = @($_.Left, $_.Top, ($_.Right - $_.Left), ($_.Bottom - $_.Top)) }
  })
  return @{ running = $true; windows = $wins }
}

function Cmd-Find($a) {
  $hit = Wait-Find $a
  if (-not $hit) { return @{ found = $false } }
  $d = Describe $hit.el $hit.win
  $d.found = $true
  $d.toggled = Get-ToggleState $hit.el
  return $d
}

function Cmd-Click($a) {
  $hit = Wait-Find $a
  if (-not $hit) { return @{ clicked = $false } }
  if ($a.focus) { [void][ZsaWin32]::Focus([IntPtr]$hit.win.Hwnd); Start-Sleep -Milliseconds 150 }
  $method = Invoke-Element $hit.el ([bool]$a.preferMouse)
  $d = Describe $hit.el $hit.win
  $d.clicked = $true
  $d.method = $method
  return $d
}

function Cmd-Toggle($a) {
  $hit = Wait-Find $a
  if (-not $hit) { return @{ found = $false } }
  $desired = [bool]$a.desired
  $state = Get-ToggleState $hit.el
  if ($null -eq $state) {
    # State cannot be read; only click when turning on, and report the result as unverified.
    if ($desired) { [void](Click-Center $hit.el) }
    return @{ found = $true; name = $hit.el.Current.Name; state = $null; verified = $false }
  }
  if ($state -ne $desired) {
    $p = $null
    if ($hit.el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle() }
    else { [void](Click-Center $hit.el) }
    Start-Sleep -Milliseconds 250
    $state = Get-ToggleState $hit.el
  }
  return @{ found = $true; name = $hit.el.Current.Name; state = $state; verified = ($state -eq $desired) }
}

function Cmd-Focus($a) {
  $wins = Get-ScopeWindows $a
  if ($wins.Count -eq 0) { return @{ focused = $false } }
  $w = $wins[0]
  $ok = [ZsaWin32]::Focus([IntPtr]$w.Hwnd)
  $moved = $false
  if ($a.fitOnScreen) {
    # Zoom can open the meeting window partly off-screen or under the taskbar, hiding its toolbar.
    $wa = [System.Windows.Forms.Screen]::FromHandle([IntPtr]$w.Hwnd).WorkingArea
    $moved = [ZsaWin32]::FitInto([IntPtr]$w.Hwnd, $wa.Left, $wa.Top, $wa.Right, $wa.Bottom)
    if ($moved) {
      Start-Sleep -Milliseconds 300
      $w = @(Get-ScopeWindows @{ scope = 'zoom'; hwnd = $w.Hwnd })[0]
    }
  }
  if ($a.revealToolbar) {
    # Zoom hides its meeting toolbar until the mouse moves over the window.
    $x = [int](($w.Left + $w.Right) / 2); $y = [int]($w.Bottom - 40)
    Hover-Point $x $y 400
  }
  return @{ focused = $ok; moved = $moved; hwnd = $w.Hwnd; title = $w.Title; cls = $w.Cls }
}

function Cmd-Scroll($a) {
  # Scrolls inside a window at a relative point (fx, fy), e.g. Zoom's share dialog list.
  $wins = Get-ScopeWindows $a
  if ($wins.Count -eq 0) { return @{ scrolled = $false } }
  $w = $wins[0]
  [ZsaWin32]::Focus([IntPtr]$w.Hwnd) | Out-Null
  $fx = if ($null -ne $a.fx) { [double]$a.fx } else { 0.4 }
  $fy = if ($null -ne $a.fy) { [double]$a.fy } else { 0.5 }
  $x = [int]($w.Left + ($w.Right - $w.Left) * $fx); $y = [int]($w.Top + ($w.Bottom - $w.Top) * $fy)
  [ZsaWin32]::Wheel($x, $y, [int]$a.clicks)
  return @{ scrolled = $true }
}

function Cmd-Keys($a) {
  $f = Cmd-Focus $a
  if (-not $f.hwnd) { return @{ sent = $false } }
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait("$($a.keys)")
  return @{ sent = $true; hwnd = $f.hwnd; title = $f.title }
}

function Cmd-Names($a) {
  $wins = Get-ScopeWindows $a
  $cond = Get-TypeCondition $a.types
  $max = if ($a.max) { [int]$a.max } else { 400 }
  $out = New-Object System.Collections.ArrayList
  foreach ($w in $wins) {
    try { $root = $UIA::FromHandle([IntPtr]$w.Hwnd) } catch { continue }
    try { $els = @($root.FindAll($Scope::Descendants, $cond)) } catch { continue }
    foreach ($el in $els) {
      if ($out.Count -ge $max) { break }
      try { $c = $el.Current } catch { continue }
      if (-not $c.Name) { continue }
      [void]$out.Add([ordered]@{ name = $c.Name; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); window = $w.Title; cls = $w.Cls; offscreen = $c.IsOffscreen })
    }
  }
  return @{ items = @($out) }
}

function Cmd-Dump($a) {
  $wins = Get-ScopeWindows $a
  $depth = if ($a.depth) { [int]$a.depth } else { 12 }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $sb = New-Object System.Text.StringBuilder
  $script:nodes = 0
  function DumpNode($el, $d) {
    if ($d -gt $depth -or $script:nodes -gt 3000) { return }
    $script:nodes++
    try {
      $c = $el.Current
      [void]$sb.AppendLine(("{0}{1} name='{2}' class='{3}' id='{4}' offscreen={5}" -f ('  ' * $d), ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''), $c.Name, $c.ClassName, $c.AutomationId, $c.IsOffscreen))
    } catch { return }
    $ch = $walker.GetFirstChild($el)
    while ($ch) { DumpNode $ch ($d + 1); $ch = $walker.GetNextSibling($ch) }
  }
  foreach ($w in $wins) {
    [void]$sb.AppendLine("=== WINDOW hwnd=$($w.Hwnd) title='$($w.Title)' class='$($w.Cls)' minimized=$($w.Minimized)")
    try { DumpNode ($UIA::FromHandle([IntPtr]$w.Hwnd)) 0 } catch { [void]$sb.AppendLine("  (UI Automation unavailable: $($_.Exception.Message))") }
  }
  return @{ text = $sb.ToString() }
}

# ---- Text recognition (Windows.Media.Ocr) -------------------------------------------------------
# Zoom draws its meeting toolbar, menus and share dialog itself and does not expose them to UI Automation,
# so these commands find controls by the text Windows' built-in OCR reads from a screen capture.

$script:Ocr = $null
function Init-Ocr {
  if ($script:Ocr) { return }
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw 'Windows text recognition is not available. Add the English language in Windows Settings > Time & language > Language.' }
  $script:Ocr = $engine
}

function Await-WinRt($op, [type]$type) {
  $task = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(20000)) { throw 'Text recognition timed out.' }
  return $task.Result
}

# The screen rectangle to read: a window, the monitor showing it, or the primary monitor; optionally a fraction of it.
function Get-OcrBase($a) {
  $hwnd = $null
  if ($a.hwnd) { $hwnd = [long]$a.hwnd }
  elseif ($a.cls -or $a.title) { $w = @(Get-ScopeWindows $a | Where-Object { ($_.Right - $_.Left) -gt 0 }); if ($w.Count) { $hwnd = $w[0].Hwnd } }
  if ($hwnd -and "$($a.area)" -ne 'screen') {
    $r = New-Object ZsaWin32+RECT
    if (-not [ZsaWin32]::GetWindowRect([IntPtr]$hwnd, [ref]$r)) { throw 'The window to read is gone.' }
    $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  } else {
    $s = if ($hwnd) { [System.Windows.Forms.Screen]::FromHandle([IntPtr]$hwnd) } else { [System.Windows.Forms.Screen]::PrimaryScreen }
    $x = $s.Bounds.X; $y = $s.Bounds.Y; $w = $s.Bounds.Width; $h = $s.Bounds.Height
  }
  if ($a.region) {
    $f = @($a.region)
    $nx = $x + [int]($w * [double]$f[0]); $ny = $y + [int]($h * [double]$f[1])
    $w = [int]($w * ([double]$f[2] - [double]$f[0])); $h = [int]($h * ([double]$f[3] - [double]$f[1]))
    $x = $nx; $y = $ny
  }
  if ($w -le 0 -or $h -le 0) { throw 'Nothing to read: the window has no visible area.' }
  return @{ x = $x; y = $y; w = $w; h = $h }
}

# Reads text in the given area. Returns lines of words with screen rectangles.
function Read-ScreenText($a) {
  Init-Ocr
  $b = Get-OcrBase $a
  if ($a.hover -and $a.hwnd) {
    # Zoom hides its meeting toolbar until the mouse moves over the window, so wiggle it there just before capturing.
    $r = New-Object ZsaWin32+RECT
    [void][ZsaWin32]::GetWindowRect([IntPtr][long]$a.hwnd, [ref]$r)
    $hx = [int]($r.Left + ($r.Right - $r.Left) * [double]@($a.hover)[0]); $hy = [int]($r.Top + ($r.Bottom - $r.Top) * [double]@($a.hover)[1])
    if ($a.physicalHover) { [ZsaWin32]::HoverAndReturn($hx, $hy, 450) } else { Hover-Point $hx $hy 450 }
  }
  $scale = if ($a.scale) { [double]$a.scale } else { 2.0 }
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $scale = [Math]::Max(1.0, [Math]::Min($scale, [Math]::Min($max / $b.w, $max / $b.h)))
  $shot = New-Object System.Drawing.Bitmap $b.w, $b.h
  $g = [System.Drawing.Graphics]::FromImage($shot)
  $g.CopyFromScreen($b.x, $b.y, 0, 0, $shot.Size)
  $g.Dispose()
  $bmp = $shot
  if ($scale -ne 1.0) {
    $bmp = New-Object System.Drawing.Bitmap ([int]($b.w * $scale)), ([int]($b.h * $scale))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($shot, 0, 0, $bmp.Width, $bmp.Height)
    $g.Dispose(); $shot.Dispose()
  }
  if ($a.save) { $bmp.Save("$($a.save)", [System.Drawing.Imaging.ImageFormat]::Png) }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  [void]$ms.Seek(0, 'Begin')
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRt ($script:Ocr.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $soft.Dispose(); $ms.Dispose()
  $lines = @()
  foreach ($ln in $result.Lines) {
    $words = @()
    foreach ($wd in $ln.Words) {
      $r = $wd.BoundingRect
      $words += [pscustomobject]@{ text = $wd.Text; x = [int]($b.x + $r.X / $scale); y = [int]($b.y + $r.Y / $scale); w = [int]($r.Width / $scale); h = [int]($r.Height / $scale) }
    }
    if ($words.Count) { $lines += [pscustomobject]@{ text = $ln.Text; words = $words } }
  }
  return @{ base = $b; lines = $lines }
}

# Finds the first run of consecutive words on one line matching a pattern (patterns tried in priority order).
function Find-Text($a) {
  $read = Read-ScreenText $a
  $patterns = @($a.patterns)
  foreach ($p in $patterns) {
    foreach ($ln in $read.lines) {
      $ws = @($ln.words)
      for ($n = [Math]::Min(6, $ws.Count); $n -ge 1; $n--) {
        for ($i = 0; $i + $n -le $ws.Count; $i++) {
          $run = $ws[$i..($i + $n - 1)]
          $text = ($run | ForEach-Object { $_.text }) -join ' '
          if (-not (Test-Match $text $p)) { continue }
          if ($a.excludeNames -and (Test-Match $text $a.excludeNames)) { continue }
          $x0 = ($run | Measure-Object x -Minimum).Minimum; $y0 = ($run | Measure-Object y -Minimum).Minimum
          $x1 = ($run | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
          $y1 = ($run | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
          return @{ found = $true; text = $text; line = $ln.text; rect = @([int]$x0, [int]$y0, [int]($x1 - $x0), [int]($y1 - $y0)) }
        }
      }
    }
  }
  return @{ found = $false; seen = @($read.lines | ForEach-Object { $_.text }) }
}

function Wait-FindText($a) {
  $timeout = if ($a.timeoutMs) { [int]$a.timeoutMs } else { 0 }
  $deadline = (Get-Date).AddMilliseconds($timeout)
  while ($true) {
    $hit = Find-Text $a
    if ($hit.found -or (Get-Date) -ge $deadline) { return $hit }
    Start-Sleep -Milliseconds 400
  }
}

function Cmd-Ocr($a) {
  $read = Read-ScreenText $a
  $lines = @($read.lines | ForEach-Object {
      $ws = @($_.words)
      $x0 = ($ws | Measure-Object x -Minimum).Minimum; $y0 = ($ws | Measure-Object y -Minimum).Minimum
      $x1 = ($ws | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
      $y1 = ($ws | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
      [ordered]@{ text = $_.text; rect = @([int]$x0, [int]$y0, [int]($x1 - $x0), [int]($y1 - $y0)); words = @($ws | ForEach-Object { [ordered]@{ text = $_.text; rect = @($_.x, $_.y, $_.w, $_.h) } }) }
    })
  return @{ base = $read.base; lines = $lines }
}

function Cmd-ClickText($a) {
  $hit = Wait-FindText $a
  if (-not $hit.found) { $hit.clicked = $false; return $hit }
  $r = $hit.rect
  # Optional offset (e.g. a toolbar icon sits above its label): [dx, dy] in pixels from the text centre.
  $dx = 0; $dy = 0
  if ($a.offset) { $dx = [int]@($a.offset)[0]; $dy = [int]@($a.offset)[1] }
  $cx = [int]($r[0] + $r[2] / 2 + $dx); $cy = [int]($r[1] + $r[3] / 2 + $dy)
  if ($a.physical) { [ZsaWin32]::PhysicalClick($cx, $cy) } else { [ZsaWin32]::Click($cx, $cy) }
  $hit.clicked = $true
  return $hit
}

# Colour statistics of a screen rectangle: used to read checkbox state (a ticked Zoom checkbox is filled blue).
function Cmd-Sample($a) {
  $r = @($a.rect)
  $w = [Math]::Max(1, [int]$r[2]); $h = [Math]::Max(1, [int]$r[3])
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$r[0], [int]$r[1], 0, 0, $bmp.Size)
  $g.Dispose()
  $blue = 0; $total = 0; $sumL = 0
  for ($x = 0; $x -lt $w; $x++) {
    for ($y = 0; $y -lt $h; $y++) {
      $c = $bmp.GetPixel($x, $y)
      $total++
      $sumL += ($c.R + $c.G + $c.B) / 3
      if ($c.B -gt 150 -and $c.B -gt ($c.R + 60)) { $blue++ }
    }
  }
  $bmp.Dispose()
  return @{ blueFraction = [Math]::Round($blue / $total, 3); brightness = [int]($sumL / $total) }
}

function Cmd-Close($a) {
  if (-not $a.hwnd) { return @{ closed = $false } }
  return @{ closed = [ZsaWin32]::PostMessage([IntPtr][long]$a.hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
}

function Invoke-Request($req) {
  $a = $req.args
  if ($null -eq $a) { $a = [pscustomobject]@{} }
  switch ("$($req.cmd)") {
    'ping' { return @{ pong = $true; ps = $PSVersionTable.PSVersion.ToString() } }
    'windows' { return Cmd-Windows $a }
    'find' { return Cmd-Find $a }
    'click' { return Cmd-Click $a }
    'toggle' { return Cmd-Toggle $a }
    'focus' { return Cmd-Focus $a }
    'scroll' { return Cmd-Scroll $a }
    'keys' { return Cmd-Keys $a }
    'names' { return Cmd-Names $a }
    'dump' { return Cmd-Dump $a }
    'ocr' { return Cmd-Ocr $a }
    'findText' { return Wait-FindText $a }
    'clickText' { return Cmd-ClickText $a }
    'close' { return Cmd-Close $a }
    'sample' { return Cmd-Sample $a }
    'move' { [ZsaWin32]::MoveMouse([int]$a.x, [int]$a.y); return @{ moved = $true } }
    'clickAt' { if ($a.physical) { [ZsaWin32]::PhysicalClick([int]$a.x, [int]$a.y) } else { [ZsaWin32]::Click([int]$a.x, [int]$a.y) }; return @{ clicked = $true } }
    'clickMode' { if ($null -ne $a.background) { [ZsaWin32]::Background = [bool]$a.background }; return @{ background = [ZsaWin32]::Background } }
    default { throw "Unknown command '$($req.cmd)'." }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $res = Invoke-Request $req
    $out = @{ id = $req.id; ok = $true; result = $res }
  } catch {
    $id = if ($req) { $req.id } else { $null }
    $out = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
