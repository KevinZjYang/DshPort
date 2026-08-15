param(
  [string]$StatusFile,
  [string]$UpdaterPid = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DshPort 更新'
$form.ClientSize = New-Object System.Drawing.Size(420, 120)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.TopMost = $true
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = '正在更新 DshPort…'
$title.Font = New-Object -TypeName 'System.Drawing.Font' -ArgumentList @('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $false
$title.Size = New-Object System.Drawing.Size(380, 30)
$title.Location = New-Object System.Drawing.Point(20, 14)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = '准备中…'
$status.AutoSize = $false
$status.Size = New-Object System.Drawing.Size(380, 22)
$status.Location = New-Object System.Drawing.Point(20, 48)
$form.Controls.Add($status)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
$bar.MarqueeAnimationSpeed = 30
$bar.Size = New-Object System.Drawing.Size(380, 16)
$bar.Location = New-Object System.Drawing.Point(20, 78)
$form.Controls.Add($bar)

# Generic delayed-close timer (used for COMPLETE / FAILED / interrupted).
$delayClose = New-Object System.Windows.Forms.Timer
$delayClose.Add_Tick({
  $delayClose.Stop()
  $form.Close()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  $text = ''
  if (Test-Path $StatusFile) {
    $text = (Get-Content $StatusFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue).Trim()
    if ($text) { $status.Text = $text }
    try {
      if ($text -match '(d{1,3})%') {
        $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
        $bar.Value = [Math]::Min(100, [int]$Matches[1])
      } else {
        $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
        $bar.MarqueeAnimationSpeed = 30
      }
    } catch {}
  }
  if ($text -eq 'COMPLETE') {
    $title.Text = '更新完成'
    $status.Text = '正在启动 DshPort…'
    try {
      $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Blocks
      $bar.Value = 100
    } catch {}
    $timer.Stop()
    $delayClose.Interval = 1500
    $delayClose.Start()
    return
  }
  if ($text -like 'FAILED *') {
    $title.Text = '更新失败'
    $status.Text = $text.Substring(7)
    $bar.Enabled = $false
    $timer.Stop()
    $delayClose.Interval = 6000
    $delayClose.Start()
    return
  }
  if ($UpdaterPid -ne '' -and -not (Get-Process -Id $UpdaterPid -ErrorAction SilentlyContinue)) {
    $title.Text = '更新中断'
    $status.Text = '更新进程意外退出，请稍后重新检查更新。'
    $bar.Enabled = $false
    $timer.Stop()
    $delayClose.Interval = 6000
    $delayClose.Start()
    return
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
