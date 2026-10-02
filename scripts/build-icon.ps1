Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(27,25,34))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(203,190,252)),22
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$points = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(65,83),[System.Drawing.PointF]::new(124,184),[System.Drawing.PointF]::new(181,83))
$graphics.DrawLines($pen,$points)
$spark = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(196,36),[System.Drawing.PointF]::new(202,52),[System.Drawing.PointF]::new(218,58),[System.Drawing.PointF]::new(202,64),[System.Drawing.PointF]::new(196,80),[System.Drawing.PointF]::new(190,64),[System.Drawing.PointF]::new(174,58),[System.Drawing.PointF]::new(190,52))
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(239,230,255))
$graphics.FillPolygon($brush,$spark)
$bitmap.Save((Join-Path $PWD 'desktop/icon.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$png = [System.IO.File]::ReadAllBytes((Join-Path $PWD 'desktop/icon.png'))
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$png.Length); $writer.Write([UInt32]22)
$writer.Write($png)
[System.IO.File]::WriteAllBytes((Join-Path $PWD 'desktop/icon.ico'),$stream.ToArray())
$writer.Dispose(); $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $pen.Dispose(); $brush.Dispose()
