# Deja las fotos de producto listas para la tienda:
#   recorta lo que sobra, blanquea el fondo y entrega un cuadrado uniforme.
#
# El fondo de las fotos es la mesa (tela clara). Para no comerse el producto, el
# fondo se detecta con un relleno por difusión DESDE LOS BORDES: solo se blanquea
# lo que está conectado al borde y se parece al color del borde. Un envase blanco
# (azúcar, sal, papel) queda intacto porque no está conectado al marco.

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$ORIGEN  = "C:\Dev\Puesta en marcha CIbox\Productos"
$dirSalida = "C:\Dev\Puesta en marcha CIbox\backend\seed-assets\productos"
$ladoFinal    = 1000      # salida final, cuadrada
$TRABAJO = 1400      # ancho de trabajo para el análisis
$TOL     = 46        # tolerancia de color contra el fondo
$MARGEN  = 0.045     # aire alrededor del producto

New-Item -ItemType Directory -Force $dirSalida | Out-Null

$cs = @'
using System;
using System.Collections.Generic;

public static class Recorte {
  // Devuelve: bytes BGRA ya recortados a cuadrado, con el fondo en blanco.
  public static byte[] Procesar(byte[] px, int w, int h, int tol, double margen, out int ladoOut) {
    int n = w * h;
    bool[] fondo = new bool[n];

    // 1. Color del fondo = mediana de la franja del borde.
    List<int> br = new List<int>(), bg = new List<int>(), bb = new List<int>();
    int franja = Math.Max(2, Math.Min(w, h) / 50);
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) {
        if (x >= franja && x < w - franja && y >= franja && y < h - franja) continue;
        int o = (y * w + x) * 4;
        bb.Add(px[o]); bg.Add(px[o + 1]); br.Add(px[o + 2]);
      }
    br.Sort(); bg.Sort(); bb.Sort();
    int fr = br[br.Count / 2], fg = bg[bg.Count / 2], fb = bb[bb.Count / 2];

    // 2. Relleno por difusión desde el marco: marca lo que es fondo real.
    Queue<int> cola = new Queue<int>();
    for (int x = 0; x < w; x++) { Encolar(px, fondo, cola, x, 0, w, fr, fg, fb, tol); Encolar(px, fondo, cola, x, h - 1, w, fr, fg, fb, tol); }
    for (int y = 0; y < h; y++) { Encolar(px, fondo, cola, 0, y, w, fr, fg, fb, tol); Encolar(px, fondo, cola, w - 1, y, w, fr, fg, fb, tol); }
    int[] dx = { 1, -1, 0, 0 }, dy = { 0, 0, 1, -1 };
    while (cola.Count > 0) {
      int p = cola.Dequeue(); int px0 = p % w, py0 = p / w;
      for (int k = 0; k < 4; k++) {
        int nx = px0 + dx[k], ny = py0 + dy[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        Encolar(px, fondo, cola, nx, ny, w, fr, fg, fb, tol);
      }
    }

    // 3. Caja del producto = todo lo que no quedó marcado como fondo.
    int x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        if (!fondo[y * w + x]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }

    // 4. Cuadrar con aire, centrado en el producto.
    int cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    int l = (int)(Math.Max(cw, ch) * (1 + 2 * margen));
    int cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    int sx = cx - l / 2, sy = cy - l / 2;
    ladoOut = l;

    byte[] outp = new byte[l * l * 4];
    for (int y = 0; y < l; y++)
      for (int x = 0; x < l; x++) {
        int o = (y * l + x) * 4;
        int ox = sx + x, oy = sy + y;
        bool blanco = ox < 0 || oy < 0 || ox >= w || oy >= h || fondo[oy * w + ox];
        if (blanco) { outp[o] = 255; outp[o + 1] = 255; outp[o + 2] = 255; outp[o + 3] = 255; }
        else {
          int io = (oy * w + ox) * 4;
          outp[o] = px[io]; outp[o + 1] = px[io + 1]; outp[o + 2] = px[io + 2]; outp[o + 3] = 255;
        }
      }
    return outp;
  }

  static void Encolar(byte[] px, bool[] fondo, Queue<int> cola, int x, int y, int w, int fr, int fg, int fb, int tol) {
    int p = y * w + x;
    if (fondo[p]) return;
    int o = p * 4;
    int b = px[o], g = px[o + 1], r = px[o + 2];
    int db = b - fb, dg = g - fg, dr = r - fr;
    int dist2 = db * db + dg * dg + dr * dr;

    bool esFondo = dist2 <= tol * tol;

    // La sombra que el producto proyecta sobre la mesa es del mismo gris que la
    // tela, solo que más oscura: se acepta con más holgura siempre que sea gris
    // (poca diferencia entre canales). Así no se lleva por delante un envase de
    // color, que sí tiene los canales separados.
    if (!esFondo) {
      int max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b));
      bool gris = (max - min) <= 26;
      int holgado = (int)(tol * 3.1);
      if (gris && max >= 72 && dist2 <= holgado * holgado) esFondo = true;
    }
    if (!esFondo) return;

    fondo[p] = true;
    cola.Enqueue(p);
  }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

# Foto de frente elegida para cada producto -> nombre del archivo final
$MAPA = [ordered]@{
  "IMG_3320" = "pasta-penne-tricolore-coliseo-400g"
  "IMG_3323" = "pasta-farfalle-coliseo-400g"
  "IMG_3356" = "pasta-spaghetti-coliseo-400g"
  "IMG_3329" = "spaghetti-carozzi-n5-400g"
  "IMG_3331" = "arroz-miraflores-largo-ancho-g1-1kg"
  "IMG_3333" = "arroz-tucapel-gran-seleccion-g2-900g"
  "IMG_3335" = "arroz-misol-g2-1kg"
  "IMG_3337" = "lentejas-misol-1kg"
  "IMG_3340" = "garbanzos-misol-1kg"
  "IMG_3342" = "porotos-blancos-misol-1kg"
  "IMG_3345" = "sal-fina-kul-bulk-1kg"
  "IMG_3347" = "azucar-dorasol-900g"
  "IMG_3349" = "salsa-san-remo-italiana-200g"
  "IMG_3351" = "salsa-pomarola-italiana-200g"
  "IMG_3353" = "salsa-coliseo-italiana-200g"
  "IMG_3363" = "cafe-cruzeiro-liofilizado-170g"
  "IMG_3367" = "te-club-ceylan-100-bolsitas"
  "IMG_3360" = "leche-colun-sin-lactosa-1l"
  "IMG_3373" = "nectar-watts-pina-1-5l"
  "IMG_3375" = "powerade-frozen-blast-850ml"
  "IMG_3325" = "papel-higienico-swan-black-4un"
  "IMG_3327" = "toalla-papel-swan-2un"
  "IMG_3358" = "cloro-gel-brillex-limon"
  "IMG_3365" = "lavalozas-fuzol-700ml"
  "IMG_3378" = "rice-cakes-deluxe-dulce-leche"
}

$i = 0
foreach ($k in $MAPA.Keys) {
  $i++
  $ruta = Join-Path $ORIGEN "$k.jpg.jpeg"
  if (-not (Test-Path $ruta)) { Write-Host "  [$i/25] FALTA $k" -ForegroundColor Red; continue }

  $frame = [System.Windows.Media.Imaging.BitmapDecoder]::Create((New-Object System.Uri $ruta), 'None', 'OnLoad').Frames[0]
  $s = $TRABAJO / $frame.PixelWidth
  $tb = New-Object System.Windows.Media.Imaging.TransformedBitmap $frame, (New-Object System.Windows.Media.ScaleTransform $s, $s)
  $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap $tb, ([System.Windows.Media.PixelFormats]::Bgra32), $null, 0
  $w = $conv.PixelWidth; $h = $conv.PixelHeight
  $px = New-Object byte[] ($w * 4 * $h)
  $conv.CopyPixels($px, $w * 4, 0)

  $ladoRecorte = 0
  $out = [Recorte]::Procesar($px, $w, $h, $TOL, $MARGEN, [ref]$ladoRecorte)

  $bmp = [System.Windows.Media.Imaging.BitmapSource]::Create(
    $ladoRecorte, $ladoRecorte, 96, 96, ([System.Windows.Media.PixelFormats]::Bgra32), $null, $out, $ladoRecorte * 4)
  $s2 = $ladoFinal / $ladoRecorte
  $fin = New-Object System.Windows.Media.Imaging.TransformedBitmap $bmp, (New-Object System.Windows.Media.ScaleTransform $s2, $s2)

  $enc = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder
  $enc.QualityLevel = 88
  $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($fin))
  $rutaArchivo = Join-Path $dirSalida "$($MAPA[$k]).jpg"
  $fs = [System.IO.File]::Create($rutaArchivo); $enc.Save($fs); $fs.Close()

  $kb = [math]::Round((Get-Item $rutaArchivo).Length / 1KB)
  Write-Host ("  [{0}/25] {1,-38} recorte {2}px -> {3}x{3}  {4} KB" -f $i, $MAPA[$k], $ladoRecorte, $ladoFinal, $kb)
}
Write-Host ""
Write-Host "Listo -> $dirSalida"
