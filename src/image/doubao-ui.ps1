# 豆包桌面版 UI 自动化助手（插件内部调用，不手工运行）
# 用法：doubao-ui.ps1 -Action detect|activate|open-create|paint|screenshot -Text <base64> -RefPath <图片路径> -Out <截图路径>
# 输出：一行 JSON 到 stdout；错误也走 JSON（ok=false），方便 Node 侧判断。
param(
  [string]$Action = 'detect',
  [string]$Text = '',
  [string]$RefPath = '',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
# 输出统一 UTF-8，否则 Node 侧拿到的中文是乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DbWin32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
try { [DbWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null } catch {}

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  [Console]::Out.WriteLine($json)
}

function Find-Doubao {
  $procs = Get-Process -Name Doubao -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  if (-not $procs) { return $null }
  return $procs | Select-Object -First 1
}

# 「没装」和「装了但没开」是两件事：这里找安装路径，用来区分并支持自动启动。
function Find-DoubaoExe {
  $cands = @()
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\Doubao\Doubao.exe') }
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'Doubao\Doubao.exe') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Doubao\Doubao.exe') }
  foreach ($key in @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Doubao.exe',
      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Doubao.exe')) {
    try {
      $v = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
      if ($v) { $cands += $v }
    } catch { }
  }
  foreach ($c in $cands) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Get-Rect($proc) {
  $r = New-Object RECT
  [DbWin32]::GetWindowRect([IntPtr]$proc.MainWindowHandle, [ref]$r) | Out-Null
  return @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
}

function Activate($proc) {
  [DbWin32]::ShowWindow([IntPtr]$proc.MainWindowHandle, 9) | Out-Null
  [DbWin32]::SetForegroundWindow([IntPtr]$proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 400
}

# 相对窗口的坐标（0~1），由截图校准得来
$REL = @{
  newChat   = @(0.14, 0.155)  # 左侧「新对话」
  imageGen  = @(0.40, 0.943)  # 新对话页底部「图像生成」（画图模式）
  input     = @(0.40, 0.32)   # 画图模式的描述输入框
  sendBtn   = @(0.53, 0.32)   # 发送按钮（备用）
  chatInput = @(0.60, 0.92)   # 新对话页底部输入框
}

function Click-Rel($proc, $rel) {
  $r = Get-Rect $proc
  $x = [int]($r.x + $r.w * $rel[0])
  $y = [int]($r.y + $r.h * $rel[1])
  [DbWin32]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [DbWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [DbWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 700
  return @{ x = $x; y = $y }
}

function Paste-Text($text) {
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 600
}

function Paste-Image($path) {
  $img = [System.Drawing.Image]::FromFile($path)
  [System.Windows.Forms.Clipboard]::SetImage($img)
  $img.Dispose()
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 1500
}

try {
  # 自动启动：只对它自己装的豆包做，别乱开别的程序
  if ($Action -eq 'launch') {
    $exe = Find-DoubaoExe
    if (-not $exe) {
      Write-Result @{ ok = $false; installed = $false; detected = $false; reason = '没装豆包桌面版' }
      exit 0
    }
    try { Start-Process -FilePath $exe | Out-Null } catch {
      Write-Result @{ ok = $false; installed = $true; detected = $false; exePath = $exe; reason = "启动豆包失败：$($_.Exception.Message)" }
      exit 0
    }
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 1000
      $p = Find-Doubao
      if ($p) {
        Write-Result @{ ok = $true; installed = $true; detected = $true; launched = $true; pid = $p.Id; title = $p.MainWindowTitle; rect = (Get-Rect $p) }
        exit 0
      }
    }
    Write-Result @{ ok = $false; installed = $true; detected = $false; exePath = $exe; reason = '豆包启动了但窗口 30 秒没出来' }
    exit 0
  }

  $proc = Find-Doubao
  if (-not $proc) {
    $exe = Find-DoubaoExe
    if ($exe) {
      Write-Result @{ ok = $false; detected = $false; installed = $true; exePath = $exe; reason = '豆包没在运行' }
    } else {
      Write-Result @{ ok = $false; detected = $false; installed = $false; reason = '没装豆包桌面版' }
    }
    exit 0
  }
  $rect = Get-Rect $proc

  switch ($Action) {
    'detect' {
      Write-Result @{ ok = $true; detected = $true; installed = $true; pid = $proc.Id; title = $proc.MainWindowTitle; rect = $rect }
    }
    'activate' {
      Activate $proc
      Write-Result @{ ok = $true; pid = $proc.Id; rect = $rect }
    }
    'open-create' {
      # 只开一个新对话：在普通对话里描述画图需求，豆包会自动进图像生成（比找按钮稳）
      Activate $proc
      $null = Click-Rel $proc $REL.newChat
      Start-Sleep -Milliseconds 1800
      Write-Result @{ ok = $true; step = 'new-chat'; pid = $proc.Id }
    }
    'paint' {
      Activate $proc
      $null = Click-Rel $proc $REL.chatInput
      Start-Sleep -Milliseconds 400
      if ($RefPath -and (Test-Path $RefPath)) { Paste-Image $RefPath }
      if ($Text) {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Text))
        Paste-Text $decoded
      }
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Start-Sleep -Milliseconds 600
      Write-Result @{ ok = $true; step = 'paint'; pid = $proc.Id; hasRef = [bool]($RefPath -and (Test-Path $RefPath)) }
    }
    'screenshot' {
      Activate $proc
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
      if (-not $Out) { $Out = Join-Path $env:TEMP 'doubao-shot.png' }
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      Write-Result @{ ok = $true; file = $Out; rect = $rect }
    }
    default {
      Write-Result @{ ok = $false; reason = "未知动作：$Action" }
    }
  }
} catch {
  Write-Result @{ ok = $false; reason = $_.Exception.Message }
}
