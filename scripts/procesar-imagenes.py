#!/usr/bin/env python3
"""
Prepara las imagenes de siluetas para Silunet.

Por cada PNG en public/images/<tematica>/ produce DOS archivos:

    <palabra>.png           el objeto tal cual, redimensionado y comprimido
    <palabra>-silueta.png   el mismo recorte pintado 100% negro

La silueta es la que se muestra durante la ronda; la version a color sirve
para revelar el objeto al cerrarla.

Por que importa el redimensionado: en la feria decenas de celulares descargan
estas imagenes por una LAN propia. Un PNG de 1.5 MB x 30 telefonos son 45 MB
por silueta. A 512 px pesan ~30-50 KB.

Los nombres se validan contra el banco REAL (dist/wordBank.js): si un archivo
no corresponde a ninguna palabra de esa tematica, se avisa y no se toca, para
no dejar imagenes que el juego nunca va a encontrar.

Uso:
    python scripts/procesar-imagenes.py            # procesa
    python scripts/procesar-imagenes.py --dry-run  # solo muestra que haria

Requiere Pillow (ya instalado). No agrega dependencias al proyecto.
"""
import io
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parent.parent
IMAGENES = RAIZ / "public" / "images"
LADO = 512          # las siluetas se muestran a ~200-300 px; 512 da margen
SUFIJO_SILUETA = "-silueta"
UMBRAL_ALFA = 8     # por debajo de esto el pixel se considera fondo

# Nombres de archivo que no coinciden con la palabra del banco.
# Se mapean a mano para no renombrar a ciegas.
ALIAS = {
    "mouse": "RATON",
    "placa-madre": "PLACA",
    "placa madre": "PLACA",
}


def sin_tildes(texto: str) -> str:
    """PLACA -> placa, TELEFONO -> telefono. Los nombres de archivo van sin tildes."""
    normal = unicodedata.normalize("NFD", texto)
    return "".join(c for c in normal if unicodedata.category(c) != "Mn").lower()


def cargar_banco() -> dict:
    """Lee el banco compilado y devuelve {tematica_sin_tildes: {palabra_normalizada: PALABRA}}."""
    script = (
        "const wb=require('./dist/wordBank.js');"
        "console.log(JSON.stringify(wb.WORD_BANK.map(w=>({w:w.word,c:w.category}))));"
    )
    salida = subprocess.run(
        ["node", "-e", script], cwd=RAIZ, capture_output=True, text=True, check=True
    ).stdout
    banco = {}
    for fila in json.loads(salida):
        clave = sin_tildes(fila["c"])
        banco.setdefault(clave, {})[sin_tildes(fila["w"])] = fila["w"]
    return banco


def palabra_de(nombre: str, palabras: dict) -> str | None:
    """Resuelve el nombre de archivo a una palabra del banco, o None."""
    base = sin_tildes(re.sub(r"[_\s]+", "-", nombre.strip()))
    if base in ALIAS:
        return ALIAS[base]
    candidato = sin_tildes(ALIAS.get(base, base))
    if candidato in palabras:
        return palabras[candidato]
    # tolera "laptop-1", "monitor (2)"
    limpio = re.sub(r"[-\s]*\(?\d+\)?$", "", base)
    return palabras.get(limpio)


def encajar(img: Image.Image) -> Image.Image:
    """Escala manteniendo proporcion y centra sobre un lienzo cuadrado transparente."""
    img = img.convert("RGBA")
    caja = img.getbbox()          # recorta el aire sobrante alrededor del objeto
    if caja:
        img = img.crop(caja)
    img.thumbnail((LADO, LADO), Image.LANCZOS)
    lienzo = Image.new("RGBA", (LADO, LADO), (0, 0, 0, 0))
    lienzo.paste(img, ((LADO - img.width) // 2, (LADO - img.height) // 2))
    return lienzo


def guardar_color(img: Image.Image, destino: Path) -> None:
    """Guarda la version a color por el camino mas liviano.

    Muchos originales vienen con paleta indexada; guardarlos en RGBA plano los
    engordaba (monitor.png pasaba de 90 KB a 303 KB). Se prueba paleta de 256
    colores y se conserva solo si de verdad pesa menos.
    """
    img.save(destino, "PNG", optimize=True)
    directo = destino.stat().st_size
    try:
        paleta = img.quantize(colors=256, method=Image.FASTOCTREE)
        buf = io.BytesIO()
        paleta.save(buf, "PNG", optimize=True)
        if buf.getbuffer().nbytes < directo:
            destino.write_bytes(buf.getvalue())
    except Exception:
        pass  # si la cuantizacion falla, se queda la version RGBA


def quitar_sueltos(mascara: Image.Image) -> Image.Image:
    """Elimina las manchas que no forman parte del objeto.

    Varias fuentes traen marca de agua de banco de imagenes (las diagonales de
    'pngtree' en tecla.png). Al pintar todo de negro la marca sobrevive dentro
    de la silueta. Como la marca flota separada del objeto, basta con quedarse
    con las regiones conectadas grandes: se conserva la mayor y cualquier otra
    que llegue a MINIMO_RELATIVO de su tamano, para no perder objetos que si
    tienen partes legitimamente separadas.
    """
    MINIMO_RELATIVO = 0.05
    trabajo = mascara.copy()
    etiqueta = 1
    pixeles = trabajo.load()
    ancho, alto = trabajo.size
    for y in range(alto):
        for x in range(ancho):
            if pixeles[x, y] == 255 and etiqueta < 255:
                ImageDraw.floodfill(trabajo, (x, y), etiqueta)
                etiqueta += 1

    conteos = trabajo.histogram()
    tamanos = {v: n for v, n in enumerate(conteos) if 0 < v < etiqueta and n}
    if not tamanos:
        return mascara
    umbral = max(tamanos.values()) * MINIMO_RELATIVO
    conservar = {v for v, n in tamanos.items() if n >= umbral}
    return trabajo.point(lambda v: 255 if v in conservar else 0)


def rellenar_huecos(mascara: Image.Image) -> Image.Image:
    """Cierra los agujeros interiores para que la silueta se vea maciza.

    placa-madre.png tiene zonas transparentes entre sus componentes y la
    silueta salia moteada de blanco. Se inunda el fondo desde el borde: lo que
    el fondo no alcanza es un hueco interior y se pinta.
    """
    ancho, alto = mascara.size
    marco = Image.new("L", (ancho + 2, alto + 2), 0)
    marco.paste(mascara, (1, 1))
    ImageDraw.floodfill(marco, (0, 0), 128)          # 128 = fondo real
    relleno = marco.point(lambda v: 0 if v == 128 else 255)
    return relleno.crop((1, 1, ancho + 1, alto + 1))


def a_silueta(img: Image.Image) -> Image.Image:
    """Todo lo opaco pasa a negro puro, macizo y sin manchas sueltas."""
    alfa = img.getchannel("A").point(lambda a: 255 if a >= UMBRAL_ALFA else 0)
    alfa = rellenar_huecos(quitar_sueltos(alfa))
    silueta = Image.new("RGBA", img.size, (0, 0, 0, 255))
    silueta.putalpha(alfa)
    return silueta


def main() -> int:
    ensayo = "--dry-run" in sys.argv
    if not IMAGENES.is_dir():
        print(f"No existe {IMAGENES}")
        return 1

    banco = cargar_banco()
    procesadas = huerfanas = 0

    for carpeta in sorted(p for p in IMAGENES.iterdir() if p.is_dir()):
        palabras = banco.get(sin_tildes(carpeta.name))
        if palabras is None:
            print(f"[!] '{carpeta.name}/' no es una tematica del banco — se omite")
            continue

        originales = [
            f for f in sorted(carpeta.glob("*.png"))
            if SUFIJO_SILUETA not in f.stem
        ]
        if not originales:
            continue
        print(f"\n{carpeta.name}/")

        for archivo in originales:
            palabra = palabra_de(archivo.stem, palabras)
            if not palabra:
                print(f"  [!] {archivo.name}: no coincide con ninguna palabra de esta tematica")
                huerfanas += 1
                continue

            destino  = carpeta / f"{sin_tildes(palabra)}.png"
            silueta  = carpeta / f"{sin_tildes(palabra)}{SUFIJO_SILUETA}.png"
            antes_kb = archivo.stat().st_size // 1024

            if ensayo:
                print(f"  {archivo.name} -> {destino.name} + {silueta.name}  ({antes_kb} KB)")
                procesadas += 1
                continue

            with Image.open(archivo) as img:
                cuadrada = encajar(img)
            guardar_color(cuadrada, destino)
            a_silueta(cuadrada).save(silueta, "PNG", optimize=True)

            if archivo.resolve() != destino.resolve():
                archivo.unlink()

            print(
                f"  {archivo.name:<22} -> {destino.name} ({destino.stat().st_size // 1024} KB)"
                f" + {silueta.name} ({silueta.stat().st_size // 1024} KB)"
                f"   [antes {antes_kb} KB]"
            )
            procesadas += 1

    print(f"\n{procesadas} imagenes procesadas" + (" (ensayo)" if ensayo else ""))
    if huerfanas:
        print(f"{huerfanas} sin correspondencia en el banco: renombralas o agrega un alias en ALIAS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
