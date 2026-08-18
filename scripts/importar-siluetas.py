#!/usr/bin/env python3
"""
Importa siluetas YA hechas a public/images/<tematica>/<palabra>-silueta.png

Diferencia con procesar-imagenes.py: aquel recibe el objeto A COLOR y deriva de
el la silueta mas la version de revelado. Este recibe imagenes que YA son
siluetas monocromas con fondo transparente, asi que no hay objeto a color que
revelar: solo se normaliza el encuadre y se guarda con el sufijo -silueta.

Los nombres se validan contra el banco REAL (dist/wordBank.js): un archivo que
no corresponda a ninguna palabra de esa tematica se avisa y no se copia, para no
dejar imagenes que el juego nunca va a encontrar.

Uso:
    python scripts/importar-siluetas.py ~/Desktop/imgs
    python scripts/importar-siluetas.py ~/Desktop/imgs --dry-run

Requiere Pillow. No agrega dependencias al proyecto.
"""
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "public" / "images"
LADO = 512          # la silueta se muestra a ~200-300 px; 512 da margen
SUFIJO_SILUETA = "-silueta"

# Nombres de archivo que no coinciden con la palabra del banco.
# Se mapean a mano para no renombrar a ciegas.
ALIAS = {
    "cascos": "CASCO",
    "disco-duro": "DISCODURO",
    "mouse": "RATON",
    "placa-madre": "PLACA",
}


def sin_tildes(texto: str) -> str:
    """PLACA -> placa, TELEFONO -> telefono. Los nombres de archivo van sin tildes."""
    normal = unicodedata.normalize("NFD", texto)
    return "".join(c for c in normal if unicodedata.category(c) != "Mn").lower()


def cargar_banco() -> dict:
    """Lee el banco compilado y devuelve {tematica_normalizada: {palabra_normalizada: PALABRA}}."""
    script = (
        "const wb=require('./dist/wordBank.js');"
        "console.log(JSON.stringify(wb.WORD_BANK.map(w=>({w:w.word,c:w.category}))));"
    )
    salida = subprocess.run(
        ["node", "-e", script], cwd=RAIZ, capture_output=True, text=True, check=True
    ).stdout
    banco = {}
    for fila in json.loads(salida):
        banco.setdefault(sin_tildes(fila["c"]), {})[sin_tildes(fila["w"])] = fila["w"]
    return banco


def palabra_de(nombre: str, palabras: dict) -> str | None:
    """Resuelve el nombre de archivo a una palabra del banco, o None."""
    limpio = sin_tildes(nombre.strip())
    guion = re.sub(r"[_\s]+", "-", limpio)
    if guion in ALIAS:
        return ALIAS[guion]
    # "DISCO DURO" -> discoduro: el banco tiene palabras compuestas sin separador
    for candidato in (guion, re.sub(r"[_\s]+", "", limpio)):
        if candidato in palabras:
            return palabras[candidato]
    # tolera "gato-1", "gato (2)"
    return palabras.get(re.sub(r"[-\s]*\(?\d+\)?$", "", guion))


def encajar(img: Image.Image) -> Image.Image:
    """Recorta el aire sobrante, escala manteniendo proporcion y centra en un cuadrado.

    Homogeneiza el tamano aparente: las fuentes traen margenes distintos y sin
    esto una silueta se ve diminuta al lado de la siguiente.
    """
    img = img.convert("RGBA")
    caja = img.getbbox()
    if caja:
        img = img.crop(caja)
    img.thumbnail((LADO, LADO), Image.LANCZOS)
    lienzo = Image.new("RGBA", (LADO, LADO), (0, 0, 0, 0))
    lienzo.paste(img, ((LADO - img.width) // 2, (LADO - img.height) // 2))
    return lienzo


def main() -> int:
    argumentos = [a for a in sys.argv[1:] if not a.startswith("--")]
    ensayo = "--dry-run" in sys.argv
    if not argumentos:
        print("Uso: python scripts/importar-siluetas.py <carpeta-origen> [--dry-run]")
        return 1

    origen = Path(argumentos[0]).expanduser()
    if not origen.is_dir():
        print(f"No existe {origen}")
        return 1

    banco = cargar_banco()
    copiadas = huerfanas = 0
    cubiertas: dict[str, set[str]] = {}

    for carpeta in sorted(p for p in origen.iterdir() if p.is_dir()):
        palabras = banco.get(sin_tildes(carpeta.name))
        if palabras is None:
            print(f"[!] '{carpeta.name}/' no es una tematica del banco — se omite")
            continue

        archivos = sorted(
            f for f in carpeta.iterdir()
            if f.suffix.lower() in {".png", ".webp"} and SUFIJO_SILUETA not in f.stem
        )
        if not archivos:
            continue
        print(f"\n{carpeta.name}/")

        salida = DESTINO / carpeta.name
        for archivo in archivos:
            palabra = palabra_de(archivo.stem, palabras)
            if not palabra:
                print(f"  [!] {archivo.name}: no coincide con ninguna palabra de esta tematica")
                huerfanas += 1
                continue

            destino = salida / f"{sin_tildes(palabra)}{SUFIJO_SILUETA}.png"
            cubiertas.setdefault(carpeta.name, set()).add(palabra)
            if ensayo:
                print(f"  {archivo.name} -> {destino.relative_to(RAIZ)}")
                copiadas += 1
                continue

            salida.mkdir(parents=True, exist_ok=True)
            with Image.open(archivo) as img:
                encajar(img).save(destino, "PNG", optimize=True)
            print(f"  {archivo.name:<24} -> {destino.name} ({destino.stat().st_size // 1024} KB)")
            copiadas += 1

    print(f"\n{copiadas} siluetas importadas" + (" (ensayo)" if ensayo else ""))
    if huerfanas:
        print(f"{huerfanas} sin correspondencia en el banco: renombralas o agrega un alias en ALIAS")

    # Cobertura: una palabra sin silueta en archivo cae al SVG generado del banco.
    for clave, palabras in sorted(banco.items()):
        tema = next((c for c in cubiertas if sin_tildes(c) == clave), clave)
        ya = {
            f.stem[: -len(SUFIJO_SILUETA)]
            for f in (DESTINO / tema).glob(f"*{SUFIJO_SILUETA}.png")
        } if (DESTINO / tema).is_dir() else set()
        faltan = sorted(w for w in palabras.values() if sin_tildes(w) not in ya)
        if faltan:
            print(f"  sin archivo en {tema}/: {', '.join(faltan)}")

    print("\nRecuerda: el escaneo ocurre AL ARRANCAR. Hay que reiniciar los nodos.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
