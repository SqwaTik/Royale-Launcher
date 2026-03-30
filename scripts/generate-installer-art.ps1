param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $ProjectRoot 'build'
if (-not (Test-Path $buildDir)) {
  New-Item -ItemType Directory -Path $buildDir | Out-Null
}

function New-Color([string]$hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

function Save-Bitmap($bitmap, [string]$targetPath) {
  $bitmap.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bitmap.Dispose()
}

function New-TextBrush() {
  return New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(238, 246, 240, 231))
}

function Draw-BrandTile($graphics, [int]$x, [int]$y, [int]$size) {
  $tileRect = New-Object System.Drawing.Rectangle $x, $y, $size, $size
  $tileRectF = New-Object System.Drawing.RectangleF ([float]$x), ([float]$y), ([float]$size), ([float]$size)
  $tileBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $tileRect,
    (New-Color '#fff1cf'),
    (New-Color '#ff9d50'),
    45
  )
  $graphics.FillRectangle($tileBrush, $tileRect)
  $tileBrush.Dispose()

  $letterBrush = New-TextBrush
  $letterFont = New-Object System.Drawing.Font('Segoe UI', [float]([Math]::Round($size * 0.43)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $graphics.DrawString('R', $letterFont, $letterBrush, $tileRectF, $format)
  $format.Dispose()
  $letterFont.Dispose()
  $letterBrush.Dispose()
}

function Draw-InstallerSidebar([string]$targetPath) {
  $bitmap = New-Object System.Drawing.Bitmap 164, 314
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $rect = New-Object System.Drawing.Rectangle 0, 0, 164, 314
  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    (New-Color '#090c12'),
    (New-Color '#2f160d'),
    90
  )
  $graphics.FillRectangle($background, $rect)
  $background.Dispose()

  $accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16, 255, 181, 104))
  $graphics.FillEllipse($accentBrush, -28, -22, 156, 116)
  $graphics.FillEllipse($accentBrush, 70, 230, 110, 90)
  $accentBrush.Dispose()

  Draw-BrandTile $graphics 48 34 68
  $graphics.Dispose()

  Save-Bitmap $bitmap $targetPath
}

function Draw-InstallerHeader([string]$targetPath) {
  $bitmap = New-Object System.Drawing.Bitmap 150, 57
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $rect = New-Object System.Drawing.Rectangle 0, 0, 150, 57
  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    (New-Color '#f7f2eb'),
    (New-Color '#ece4d8'),
    0
  )
  $graphics.FillRectangle($background, $rect)
  $background.Dispose()

  $accentBrush = New-Object System.Drawing.SolidBrush (New-Color '#ffb56e')
  $graphics.FillRectangle($accentBrush, 0, 52, 150, 5)
  $accentBrush.Dispose()
  Draw-BrandTile $graphics 96 8 34
  $graphics.Dispose()

  Save-Bitmap $bitmap $targetPath
}

Draw-InstallerSidebar (Join-Path $buildDir 'installerSidebar.bmp')
Draw-InstallerSidebar (Join-Path $buildDir 'uninstallerSidebar.bmp')
Draw-InstallerHeader (Join-Path $buildDir 'installerHeader.bmp')
