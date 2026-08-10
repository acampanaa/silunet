# Imágenes del proyecto

Todo lo que se ponga aquí queda accesible desde el navegador en `/images/<archivo>`.
Ejemplo: `public/images/silueta-gato.png`  ->  `<img src="/images/silueta-gato.png">`

## Por qué aquí y no en la raíz del proyecto

El servidor sirve archivos estáticos **únicamente** desde `public/`
(ver `PUBLIC_DIR` en `src/server.ts`). Una carpeta `images/` en la raíz del
repositorio no sería alcanzable por el navegador: daría 404.

## Formatos soportados

`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`, `.ico`
Si hace falta otro, hay que agregarlo al mapa `MIME` de `src/server.ts`.

## Ojo con el peso

La feria corre sobre una LAN propia y decenas de celulares cargan estas
imágenes a la vez. Conviene comprimirlas antes de subirlas.

## Qué NO va aquí

- **Siluetas del juego**: son SVG escritos a mano dentro de `src/wordBank.ts`,
  no archivos. Así se les cambia el color por CSS y no dependen de red.
- **Logos e identidad de marca**: ya viven en `public/assets/`.
