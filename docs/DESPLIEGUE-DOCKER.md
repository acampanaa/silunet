# Despliegue Docker de Silunet

Hay dos formas soportadas. Para una defensa o feria, conviene ejecutar el clúster completo
en una laptop. Para demostrar distribución física, se ejecuta un nodo en cada laptop.

## Opción A: clúster completo en una laptop

Requisitos: Docker Desktop abierto y los puertos `3001`, `3002`, `3003` y `8080`
libres.

```powershell
.\scripts\docker-cluster.ps1 up
```

Direcciones:

- jugadores: `http://localhost:8080/join`;
- pantalla maestra: `http://localhost:8080/master`;
- desde celulares de la misma Wi-Fi: sustituir `localhost` por la IP LAN de la laptop.

El gateway Nginx presenta una sola dirección y distribuye las conexiones entre los tres
backends. Si el backend de un navegador cae, el navegador se conecta de nuevo al mismo gateway
y este selecciona otro nodo vivo.

Comandos cotidianos:

```powershell
.\scripts\docker-cluster.ps1 status
.\scripts\docker-cluster.ps1 logs
.\scripts\docker-cluster.ps1 restart
.\scripts\docker-cluster.ps1 down
```

`down` conserva PostgreSQL y las tres réplicas durables. No usa `down -v`.

### Enlace público temporal

```powershell
.\scripts\docker-cluster.ps1 tunnel
```

El script muestra los logs de `cloudflared`. Copiar la URL
`https://...trycloudflare.com`; se pueden abrir `/join` y `/master` sobre esa misma URL.
El túnel publica únicamente el gateway, no PostgreSQL ni los puertos internos del clúster.

Es un Quick Tunnel temporal: la URL cambia al reiniciarlo. Para una instalación permanente se
debe usar un túnel nombrado con dominio propio.

### Prueba de fuego del cluster con tunnel

Con una partida activa y los tres nodos sanos, ejecutar:

```powershell
.\scripts\docker-cluster.ps1 fire
```

El script detecta el coordinador vigente y lo mata inmediatamente. No usa `stop`, porque
`stop` espera un cierre gradual y no representa una falla abrupta. Los dos nodos restantes
conservan quorum, eligen coordinador y los navegadores se reconectan a la misma URL publica;
el enlace `trycloudflare.com` no cambia.

Al terminar la observacion, reintegrar la replica:

```powershell
.\scripts\docker-cluster.ps1 recover
```

No se debe matar un segundo nodo antes de ejecutar `recover`.
## Opción B: un nodo Docker en cada laptop

### 1. Preparar la red

- Conectar las tres laptops al mismo router.
- Reservar sus IP para que no cambien durante la demostración.
- Desactivar AP/Client Isolation.
- Permitir TCP `3001` en el firewall de cada laptop.
- Copiar o clonar el mismo repositorio en las tres.

Ejemplo usado abajo:

| Nodo | IP |
|---|---|
| node1 | `192.168.1.11` |
| node2 | `192.168.1.12` |
| node3 | `192.168.1.13` |

### 2. Generar `.env.node` en cada máquina

En node1:

```powershell
.\scripts\configure-docker-node.ps1 -NodeId node1 `
  -Node1Host 192.168.1.11 -Node2Host 192.168.1.12 -Node3Host 192.168.1.13
```

En node2 y node3 se ejecuta el mismo comando cambiando solamente `-NodeId`.
El script calcula `PEERS` y `PUBLIC_NODES`; no hay que escribir las listas manualmente.
`.env.node` está ignorado por Git porque puede contener la conexión de base de datos.

### 3. Arrancar y comprobar

En las tres laptops:

```powershell
.\scripts\docker-node.ps1 up
.\scripts\docker-node.ps1 info
```

Abrir cualquiera de estas direcciones:

```text
http://192.168.1.11:3001/join
http://192.168.1.12:3001/join
http://192.168.1.13:3001/master
```

En `info` deben aparecer dos peers conectados, `quorumAvailable: true` y
`quorumRequired: 2`.

### 4. PostgreSQL compartido, opcional pero recomendado

Sin `DATABASE_URL`, cada nodo usa historia local. El estado vivo, las réplicas y el failover
siguen funcionando, pero el historial global no es consistente.

Para compartir PostgreSQL desde node1, elegir una contraseña y limitar el firewall de `5432`
a las IP de las tres laptops:

```powershell
$env:POSTGRES_PASSWORD='SilunetDemo2026'
$env:POSTGRES_BIND_IP='192.168.1.11'
docker compose up -d postgres
```

Después, volver a generar `.env.node` en las tres laptops agregando:

```powershell
-DatabaseUrl 'postgresql://silunet:SilunetDemo2026@192.168.1.11:5432/silunet'
```

Si la contraseña contiene símbolos reservados de URL, deben codificarse. Para una red no
controlada es preferible PostgreSQL administrado con TLS, no publicar `5432` directamente.

## Prueba de caída

En la laptop que aloja al coordinador actual:

```powershell
.\scripts\docker-node.ps1 fire
```

Los otros dos nodos conservan quorum, eligen coordinador y continúan. Para reintegrarlo:

```powershell
.\scripts\docker-node.ps1 recover
```

No se debe derribar un segundo nodo antes de reintegrar el primero: una sola réplica pierde
quorum y se detiene deliberadamente para evitar split-brain.

## Diagnóstico rápido

```powershell
.\scripts\docker-node.ps1 status
.\scripts\docker-node.ps1 logs
Test-NetConnection 192.168.1.12 -Port 3001
```

Si el contenedor está sano pero los peers no aparecen, el problema suele ser firewall, IP
equivocada o aislamiento entre clientes Wi-Fi.
