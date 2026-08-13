# 08 · Siluetas y recursos offline

Replicar el estado no replica automáticamente los archivos. Un snapshot puede decir:

```text
image = /images/computadores/router-silueta.png
```

pero esa ruta deja de responder cuando se apaga el servidor HTTP. Por eso la continuidad visual
necesita una estrategia adicional.

## Dos representaciones de la silueta

Cada `WordEntry` puede contener:

- `svg`: silueta embebida como texto dentro del snapshot;
- `image`: ruta opcional a una imagen de archivo;
- `reveal`: ruta opcional a la imagen a color mostrada al cerrar la ronda.

El SVG embebido es el último respaldo: ya viaja dentro del JSON y no requiere otra descarga. Las
imágenes de archivo pueden verse mejor, pero necesitan precarga.

## Descubrimiento de recursos

Al aceptar un `P2P_SNAPSHOT`, cada navegador revisa:

- todas las entradas de `snapshot.rounds`;
- la palabra de `snapshot.round`, si existe;
- las propiedades `image` y `reveal` que no sean ya data URL.

Luego elimina rutas duplicadas. Es importante recorrer **todas las rondas**, no solo la activa:
la prueba exige iniciar una siguiente ronda cuando Node ya está muerto.

## Conversión a data URL

Por cada ruta, `cacheAsset()` hace lo siguiente mientras HTTP está disponible:

1. ejecuta `fetch(url, { cache: 'force-cache' })`;
2. convierte la respuesta en `Blob`;
3. usa `FileReader.readAsDataURL(blob)`;
4. guarda el resultado en `assetCache`.

Una data URL contiene los bytes dentro de una cadena:

```text
data:image/png;base64,iVBORw0KGgoAAA...
```

Después de la caída, `assetUrl()` devuelve esa cadena en lugar de la ruta HTTP original.

## Indicador de preparación

`offlineAssetsReady` se vuelve verdadero solo cuando:

- el snapshot ya contiene una cola de rondas;
- todas las rutas encontradas pudieron convertirse o no había rutas externas.

La interfaz muestra:

- **“Partida offline lista · imágenes guardadas en este celular”**, o
- **“Partida offline lista · siluetas embebidas”** si no había archivos externos.

Este aviso es diferente de **“Respaldo P2P listo entre jugadores”**:

| Aviso | Garantiza |
|---|---|
| Respaldo P2P listo | DataChannels abiertos con todos los jugadores. |
| Partida offline lista | Cola de rondas recibida y recursos de imagen disponibles localmente. |

Para una demo segura deben aparecer ambos antes de desconectar la laptop.

## Renderizado con fallback

`renderSilhouette()` primero coloca el SVG embebido. Después intenta cargar la imagen preferida.
Solo reemplaza el SVG cuando `Image.onload` confirma que la imagen se pudo renderizar.

Si falla la imagen:

- no borra el SVG;
- no deja un signo de interrogación por depender de HTTP;
- mantiene una silueta funcional aunque el archivo externo no esté disponible.

Esta estrategia aplica **degradación elegante**: se prefiere el recurso de mayor calidad, pero se
conserva una representación básica independiente del servidor.

## Qué valida la prueba de fuego

Antes de matar Node, [`P2PFireTest.java`](../../test/selenium/P2PFireTest.java) espera que:

```text
offlineAssetsReady === true
```

y exige que ambos jugadores tengan por lo menos un valor de `assetCache` que empiece con `data:`.
Esto evita un falso positivo donde el juego continúa lógicamente, pero las imágenes se rompen en
la siguiente ronda.

## Límites de la caché actual

- Vive en memoria JavaScript; no es IndexedDB ni Cache Storage durable.
- Se pierde al recargar o cerrar la pestaña.
- Consume memoria proporcional a los recursos de la partida.
- Una data URL suele ocupar más que el binario original por la codificación Base64.
- Los avatares personalizados no forman parte de este caché crítico; la continuidad se enfoca en
  siluetas y revelaciones del juego.

## Por qué no basta la caché HTTP del navegador

Aunque `fetch` pide `force-cache`, confiar únicamente en el caché HTTP sería menos explícito: una
entrada puede no existir, ser revalidada o depender de políticas del navegador. Convertir el blob
a data URL y guardarlo en `assetCache` ofrece una referencia que no realiza red al renderizar.

## Posible evolución

Si se quisiera sobrevivir también a una recarga, los recursos podrían ir a Cache Storage o
IndexedDB y el snapshot a almacenamiento durable. Eso ampliaría el modelo de continuidad y
obligaría a resolver expiración, versiones, privacidad y restauración segura. No es parte de la
prueba actual.

Código principal: `snapshotAssetUrls`, `cacheSnapshotAssets`, `cacheAsset`, `assetUrl` y
`renderSilhouette` en [`public/p2p.js`](../../public/p2p.js).

Anterior: [07 · Motor Clásico](07-motor-clasico-sin-host.md). Siguiente:
[09 · Prueba de fuego](09-prueba-de-fuego.md).
