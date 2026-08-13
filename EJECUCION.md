# Cómo ejecutar Silunet

Esta guía cubre el despliegue recomendado para la demostración: **una laptop
host**, un **router independiente** y entre **2 y 5 jugadores**. El host sirve la
aplicación y señaliza el primer encuentro; después, los navegadores mantienen una
malla WebRTC capaz de continuar el modo Clásico si la laptop desaparece.

## 1. Requisitos

- Node.js 22 o superior.
- Un navegador moderno en la laptop y en cada celular.
- Un router o punto de acceso independiente con *AP/Client Isolation* desactivado.
- Git, únicamente si se clonará el repositorio.
- Docker Desktop, opcional, solo para levantar PostgreSQL local.

La laptop no debe funcionar como hotspot durante la prueba de fuego: el router debe
permanecer encendido cuando se desconecte la laptop.

## 2. Instalación

```powershell
npm install
npm run build
```

El build genera `dist/`; esa carpeta y los reportes de pruebas no se versionan.

## 3. Arranque recomendado

En PowerShell:

```powershell
.\scripts\node1.ps1
```

También puede arrancarse directamente:

```powershell
$env:NODE_ID="host-p2p"
$env:PORT="3001"
node dist/server.js
```

La consola muestra dos direcciones:

- `http://localhost:3001/master`: pantalla maestra.
- `http://IP-DE-LA-LAPTOP:3001/join`: enlace para los celulares.

Si Windows pregunta por el firewall, permitir Node.js en la red privada.

## 4. Preparar la continuidad P2P

1. Conectar la laptop y todos los celulares al mismo router.
2. Abrir `/master` en la laptop y `/join` en cada celular.
3. Esperar en todos los celulares el aviso **“Respaldo P2P listo entre jugadores”**.
4. Iniciar una partida en modo **Clásico**.
5. Esperar el aviso **“Partida offline lista”** en cada celular. Esto confirma que
   las imágenes de las rondas ya están guardadas localmente.

No desconectar la laptop antes de ambos avisos. Si el primero no aparece, revisar
*Client Isolation*, VPN, datos móviles y que todos estén realmente en la misma LAN.

## 5. Prueba de fuego

Con una ronda clásica en curso, apagar el Wi-Fi de la laptop o detener el servidor.
El router debe seguir encendido.

En aproximadamente 4–5 segundos:

1. Los celulares detectan la ausencia de `PONG`, incluso si el WebSocket queda
   falsamente abierto.
2. La mayoría confirma la caída.
3. Bully elige un único navegador jugador como coordinador.
4. Continúan reloj, siluetas, respuestas, puntajes y rondas.

Limitaciones durante la caída:

- Solo continúa el modo Clásico.
- No pueden entrar jugadores nuevos ni recargarse las páginas.
- La pantalla master de la laptop desconectada deja de actualizarse.
- El historial se persiste cuando existe un host y una base disponibles; no forma
  parte del camino crítico del failover.

## 6. PostgreSQL opcional con Docker

SQLite es suficiente para una demostración local. Para perfiles e historial en
PostgreSQL:

```powershell
docker compose up -d postgres
$env:DATABASE_URL="postgresql://silunet:silunet_dev@localhost:5432/silunet"
.\scripts\node1.ps1
```

Docker no mantiene viva la partida. La continuidad corresponde a las réplicas WebRTC
de los navegadores.

## 7. Pruebas antes de presentar

```powershell
npm run build
npm run test:unit
npm run test:junit
npm run test:p2p-fire
```

`test:p2p-fire` abre navegadores Chrome reales, forma la malla, neutraliza el evento
`onclose`, mata el único servidor y comprueba que ambos jugadores eligen el mismo
líder, conservan imágenes locales, aceptan respuestas y avanzan de ronda.

## 8. Clúster de servidores opcional

`scripts/node2.ps1`, `scripts/node3.ps1` y `npm run vv:caos` se conservan como
validación avanzada del clúster de procesos. No son necesarios para el despliegue de
una laptop ni para la continuidad P2P entre celulares. La configuración completa se
documenta en la sección “Modo B” del [`README.md`](README.md).

## 9. Problemas frecuentes

| Síntoma | Solución |
|---|---|
| Los celulares no abren el enlace | Usar la IP LAN, no `localhost`, y permitir el puerto 3001 en el firewall. |
| No aparece “Respaldo P2P listo” | Desactivar *AP/Client Isolation* y VPN; comprobar que los celulares se vean entre sí. |
| Al apagar la laptop también desaparece la Wi-Fi | La laptop era el hotspot; usar un router independiente. |
| Tras editar TypeScript no cambia el sistema | Ejecutar `npm run build` y reiniciar el servidor. |
| Aparece una versión anterior en el celular | Cerrar la pestaña y volver a entrar desde `/join`. |
| PostgreSQL no responde | Quitar temporalmente `DATABASE_URL`; el juego puede usar SQLite local. |
