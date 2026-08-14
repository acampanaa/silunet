# Silunet distribuido en tres laptops físicas

Esta guía despliega una réplica backend en cada una de tres laptops conectadas a la misma red local. A diferencia del clúster Docker de una sola máquina, aquí la pérdida completa de una laptop deja dos hosts físicos capaces de mantener quorum y continuar la partida.

Para la modalidad sencilla con una sola laptop y enlace Cloudflare, vuelve a [README.md](README.md).

## Resultado esperado

```mermaid
flowchart TB
    C[Celulares] -->|HTTP + WebSocket LAN| L1
    C -->|reconexión| L2
    C -->|reconexión| L3
    M[Navegador /master] --> L1

    subgraph LAN[Red local privada]
      L1[Laptop 1 · node1 · :3001]
      L2[Laptop 2 · node2 · :3001]
      L3[Laptop 3 · node3 · :3001]
      L1 <-->|N2N + heartbeat| L2
      L2 <-->|N2N + heartbeat| L3
      L1 <-->|N2N + heartbeat| L3
    end

    L1 --> D1[(réplica 1)]
    L2 --> D2[(réplica 2)]
    L3 --> D3[(réplica 3)]
```

Cada laptop ejecuta el mismo contenedor. Solo cambian `NODE_ID` y su lista de peers. Los navegadores reciben las tres direcciones mediante `PUBLIC_NODES`, de manera que pueden rotar a otra laptop si la conexión actual desaparece.

## Antes de comenzar

Necesitas:

- tres laptops con Docker Desktop abierto;
- el mismo repositorio y la misma revisión en las tres;
- un router o punto de acceso que permita comunicación entre clientes;
- IPs privadas estables o reservadas;
- PowerShell;
- acceso de administrador para crear la regla del firewall.

No necesitas internet durante la partida una vez que las imágenes estén construidas. Tampoco necesitas Cloudflare, abrir puertos en el router ni hacer *port forwarding*.

> Usa una red privada y controlada. No publiques el puerto `3001` directamente en internet.

---

## 1. Preparar la red

### Elegir las direcciones

Esta guía usa el siguiente ejemplo. Sustituye las IP por las de tu red:

| Equipo | Nodo | IPv4 de ejemplo | Puerto |
| --- | --- | --- | --- |
| Laptop 1 | `node1` | `192.168.1.11` | `3001` |
| Laptop 2 | `node2` | `192.168.1.12` | `3001` |
| Laptop 3 | `node3` | `192.168.1.13` | `3001` |

Para conocer la IP en cada laptop:

```powershell
ipconfig
```

Busca “Dirección IPv4” en el adaptador Wi-Fi o Ethernet que realmente estés usando. No uses:

- `127.0.0.1`;
- una dirección de Docker, WSL, VPN o VirtualBox;
- una IPv6 temporal;
- una IP que cambie al reconectar.

Lo ideal es reservar las tres direcciones desde el router. Si no puedes, verifica `ipconfig` antes de cada demostración.

### Desactivar aislamiento entre clientes

En el router debe estar desactivada cualquier opción llamada:

- AP Isolation;
- Client Isolation;
- Wireless Isolation;
- Guest Network Isolation.

Una red de invitados suele bloquear la comunicación laptop-laptop aunque todas tengan internet.

### Marcar la red como privada en Windows

Hazlo únicamente si confías en esa red:

```powershell
Get-NetConnectionProfile
Set-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -NetworkCategory Private
```

Cambia `'Wi-Fi'` si el adaptador tiene otro nombre.

---

## 2. Configurar el firewall

Ejecuta PowerShell como administrador en las tres laptops:

```powershell
New-NetFirewallRule `
  -DisplayName 'Silunet Node TCP 3001' `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 3001 `
  -Action Allow `
  -Profile Private `
  -RemoteAddress LocalSubnet
```

La regla permite:

- tráfico backend-backend;
- acceso desde celulares de la misma subred;
- reconexión del navegador hacia cualquiera de las tres réplicas.

Para comprobar que existe:

```powershell
Get-NetFirewallRule -DisplayName 'Silunet Node TCP 3001'
```

Para eliminarla al terminar definitivamente:

```powershell
Remove-NetFirewallRule -DisplayName 'Silunet Node TCP 3001'
```

No abras `5432` salvo que decidas usar PostgreSQL compartido y hayas leído la sección correspondiente.

---

## 3. Tener exactamente el mismo código

En las tres laptops:

```powershell
git clone https://github.com/acampanaa/silunet.git
cd silunet
git rev-parse --short HEAD
```

El último comando debe mostrar el mismo identificador en las tres. Si una laptop ejecuta una versión distinta del protocolo, puede conectarse pero rechazar mensajes o replicar estados incompatibles.

Si ya estaban clonadas:

```powershell
git status
git pull --ff-only
```

No uses `git pull` a ciegas si hay cambios locales sin guardar.

---

## 4. Generar `.env.node` en cada laptop

El script calcula `PEERS` y `PUBLIC_NODES`; no escribas las listas manualmente.

### Laptop 1

```powershell
.\scripts\configure-docker-node.ps1 `
  -NodeId node1 `
  -Node1Host 192.168.1.11 `
  -Node2Host 192.168.1.12 `
  -Node3Host 192.168.1.13
```

### Laptop 2

```powershell
.\scripts\configure-docker-node.ps1 `
  -NodeId node2 `
  -Node1Host 192.168.1.11 `
  -Node2Host 192.168.1.12 `
  -Node3Host 192.168.1.13
```

### Laptop 3

```powershell
.\scripts\configure-docker-node.ps1 `
  -NodeId node3 `
  -Node1Host 192.168.1.11 `
  -Node2Host 192.168.1.12 `
  -Node3Host 192.168.1.13
```

Se crea `.env.node`, ignorado por Git. Revisa el resultado:

```powershell
Get-Content .env.node
```

En cada equipo debe cambiar `NODE_ID`, pero las tres líneas de `PUBLIC_NODES` deben describir las mismas direcciones.

---

## 5. Levantar las réplicas

En cada laptop:

```powershell
.\scripts\docker-node.ps1 up
```

Puedes arrancarlas en cualquier orden. Mientras solo exista una réplica es normal que no haya quorum. En cuanto dos nodos se vean, el quorum requerido 2/3 queda disponible; con las tres arriba cada nodo debe mostrar dos peers.

Consulta el estado en cada laptop:

```powershell
.\scripts\docker-node.ps1 status
.\scripts\docker-node.ps1 info
```

La salida de `info` debe incluir:

```text
coordinator       node1, node2 o node3
connectedPeers    dos nodos
quorumRequired    2
quorumAvailable   true
replicaIndex      número mayor o igual que 1
```

El coordinador inicial suele ser `node1`, pero puede cambiar. Para cualquier prueba usa siempre el valor actual de `coordinator`; no asumas que sigue siendo `node1`.

---

## 6. Probar conectividad entre laptops

Desde Laptop 1:

```powershell
Test-NetConnection 192.168.1.12 -Port 3001
Test-NetConnection 192.168.1.13 -Port 3001
```

Desde Laptop 2:

```powershell
Test-NetConnection 192.168.1.11 -Port 3001
Test-NetConnection 192.168.1.13 -Port 3001
```

Desde Laptop 3:

```powershell
Test-NetConnection 192.168.1.11 -Port 3001
Test-NetConnection 192.168.1.12 -Port 3001
```

En las seis comprobaciones debe aparecer:

```text
TcpTestSucceeded : True
```

Si falla una dirección, no empieces la partida todavía. Revisa IP, perfil privado, firewall, Docker y aislamiento del router.

---

## 7. Abrir el juego

Puedes usar cualquiera de las tres réplicas como entrada inicial. Por ejemplo:

```text
Pantalla:  http://192.168.1.11:3001/master
Jugadores: http://192.168.1.11:3001/join
```

También funcionan:

```text
http://192.168.1.12:3001/master
http://192.168.1.13:3001/join
```

Recomendación para la exposición:

1. Proyecta `/master` desde una laptop cuyo navegador permanezca abierto.
2. Abre `/join` en los celulares mediante el QR.
3. Une al menos dos jugadores.
4. Inicia modo Clásico.
5. Antes de la prueba de fuego, verifica `quorumAvailable: true`.

### Anotación sobre la pantalla maestra

Si solo matas el contenedor `node` de la laptop proyectada, su navegador sigue vivo y se reconecta a otra réplica.

Si apagas físicamente esa laptop o desconectas toda su red, su pantalla también desaparece. Los celulares pueden continuar, pero necesitarás abrir `/master` desde otra laptop para volver a proyectar. Para demostrar una pérdida física sin perder la proyección, usa una cuarta computadora o una pantalla independiente como cliente `/master`.

---

## 8. Prueba de fuego física

### Identificar el coordinador

Desde cualquier laptop sana:

```powershell
Invoke-RestMethod http://192.168.1.11:3001/api/info |
  Select-Object nodeId,coordinator,connectedPeers,quorumAvailable,phase
```

Si `node1` no responde, consulta `node2` o `node3`. Anota el valor de `coordinator`.

### Opción A: matar solo el contenedor

En la laptop que aloja al coordinador actual:

```powershell
.\scripts\docker-node.ps1 fire
```

Esto simula una caída abrupta del proceso y deja encendida la laptop. Es la opción más limpia para una defensa porque permite seguir viendo logs y usar el navegador de esa máquina.

### Opción B: perder el host físico

En la laptop coordinadora puedes:

- apagarla;
- desconectar su cable de red;
- desactivar su Wi-Fi;
- cortar Docker Desktop.

Esta variante demuestra pérdida del host, pero también elimina cualquier `/master` que estuviera abierto allí.

### Qué debe ocurrir

Los dos nodos supervivientes deben:

1. dejar de recibir heartbeats;
2. conservar quorum 2/3;
3. ejecutar la elección Bully;
4. acordar un coordinador distinto;
5. recuperar la réplica durable más reciente;
6. reanudar el motor;
7. aceptar la reconexión de celulares por otra IP.

En los celulares puede aparecer durante algunos segundos “buscando un nodo”. No cambia el QR ni se genera un túnel: el navegador prueba las direcciones de `PUBLIC_NODES` hasta encontrar una réplica viva.

Verifica contra un superviviente:

```powershell
Invoke-RestMethod http://192.168.1.12:3001/api/info |
  Select-Object coordinator,connectedPeers,quorumAvailable,replicaIndex,phase
```

Debe haber coordinador nuevo y `quorumAvailable: true`.

### Reintegrar la laptop

Si solo mataste el contenedor, en esa misma máquina:

```powershell
.\scripts\docker-node.ps1 recover
```

Si apagaste el host, vuelve a encenderlo, abre Docker Desktop y ejecuta:

```powershell
.\scripts\docker-node.ps1 up
```

La réplica carga su archivo durable, se sincroniza y vuelve como seguidora. Espera a que esté `healthy` y confirme dos peers.

> Regla de oro: no derribes un segundo nodo antes de reintegrar el primero. Una réplica sola no tiene mayoría y suspende acciones para impedir dos verdades simultáneas.

---

## 9. PostgreSQL compartido, opcional

El failover del estado vivo funciona sin PostgreSQL porque cada backend conserva su propia réplica durable. Sin `DATABASE_URL`, sin embargo, cada laptop mantiene historial local y el salón de la fama puede diferir.

Para compartir historial, puedes alojar PostgreSQL en Laptop 1.

### Levantar PostgreSQL en Laptop 1

```powershell
$env:POSTGRES_PASSWORD='SilunetDemo2026'
$env:POSTGRES_BIND_IP='192.168.1.11'
docker compose -f compose.yaml up -d postgres
```

En Laptop 1, crea una regla restringida a las otras dos direcciones:

```powershell
New-NetFirewallRule `
  -DisplayName 'Silunet PostgreSQL TCP 5432' `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 5432 `
  -Action Allow `
  -Profile Private `
  -RemoteAddress 192.168.1.12,192.168.1.13
```

Regenera `.env.node` en las tres laptops agregando:

```powershell
-DatabaseUrl 'postgresql://silunet:SilunetDemo2026@192.168.1.11:5432/silunet'
```

Ejemplo completo para Laptop 2:

```powershell
.\scripts\configure-docker-node.ps1 `
  -NodeId node2 `
  -Node1Host 192.168.1.11 `
  -Node2Host 192.168.1.12 `
  -Node3Host 192.168.1.13 `
  -DatabaseUrl 'postgresql://silunet:SilunetDemo2026@192.168.1.11:5432/silunet'

.\scripts\docker-node.ps1 up
```

Anotaciones:

- usa la misma URL en las tres laptops;
- codifica caracteres reservados si la contraseña contiene `@`, `:`, `/` o `%`;
- si Laptop 1 cae, la partida viva continúa, pero el historial queda pendiente hasta que PostgreSQL vuelva;
- para una red no controlada, usa PostgreSQL con TLS en vez de publicar `5432`.

---

## 10. Comandos por laptop

| Acción | Comando |
| --- | --- |
| Crear configuración | `.\scripts\configure-docker-node.ps1 ...` |
| Construir y levantar | `.\scripts\docker-node.ps1 up` |
| Estado del contenedor | `.\scripts\docker-node.ps1 status` |
| Estado distribuido JSON | `.\scripts\docker-node.ps1 info` |
| Logs recientes | `.\scripts\docker-node.ps1 logs` |
| Reiniciar proceso | `.\scripts\docker-node.ps1 restart` |
| Caída inmediata | `.\scripts\docker-node.ps1 fire` |
| Reintegrar después de `fire` | `.\scripts\docker-node.ps1 recover` |
| Detener y retirar contenedor | `.\scripts\docker-node.ps1 down` |

`down` conserva el volumen de réplica. No uses `down -v` si quieres demostrar recuperación durable.

---

## 11. Diagnóstico

### `TcpTestSucceeded : False`

Revisa, en este orden:

1. la IP actual con `ipconfig`;
2. que Docker Desktop esté abierto;
3. que el contenedor esté `Up`;
4. el perfil de red `Private`;
5. la regla TCP `3001`;
6. AP/Client Isolation;
7. VPN o antivirus con firewall propio.

### Cada nodo solo se ve a sí mismo

Las IP de `.env.node` son incorrectas o el puerto está bloqueado. Compara los tres archivos y ejecuta las seis pruebas `Test-NetConnection`.

### Dos nodos creen coordinadores distintos

No sigas jugando. Reintegra los tres nodos, confirma conectividad completa y espera quorum estable. No borres volúmenes durante el diagnóstico.

### Los celulares cargan pero no reconectan

Comprueba que `PUBLIC_NODES` contenga las tres IP y que el celular pueda abrir manualmente `/api/info` en cada una:

```text
http://192.168.1.11:3001/api/info
http://192.168.1.12:3001/api/info
http://192.168.1.13:3001/api/info
```

Si una laptop responde desde otra laptop pero no desde el celular, el router probablemente aísla clientes Wi-Fi.

### Se pierde quorum al matar un nodo

Antes de la caída, los otros dos nodos no estaban realmente conectados entre sí. `connectedPeers` debe contener dos entradas en los tres equipos antes de probar.

### Cambió una IP

Regenera `.env.node` en las tres laptops con el nuevo mapa y recrea los nodos:

```powershell
.\scripts\docker-node.ps1 up
```

### El historial no coincide

Eso es esperado si `DATABASE_URL` está vacío. Las réplicas del juego y el historial son responsabilidades diferentes. Configura PostgreSQL compartido si necesitas un salón de la fama único.

---

## Lista de comprobación para imprimir

### Antes de la exposición

- [ ] Las tres laptops muestran la misma revisión Git.
- [ ] Docker Desktop está abierto en las tres.
- [ ] Las IP coinciden con `.env.node`.
- [ ] La red está marcada como privada.
- [ ] TCP `3001` está permitido en las tres.
- [ ] AP/Client Isolation está desactivado.
- [ ] Las seis pruebas `Test-NetConnection` pasan.
- [ ] Los tres contenedores están `healthy`.
- [ ] Cada `info` muestra dos peers y quorum `true`.
- [ ] `/master` abre y el QR apunta a una IP accesible.
- [ ] Al menos dos celulares entran y pueden votar/responder.

### Durante la prueba de fuego

- [ ] La partida está en una ronda activa.
- [ ] Se anotó el coordinador vigente.
- [ ] Se derriba únicamente ese nodo.
- [ ] Los celulares permanecen abiertos.
- [ ] Aparece un coordinador distinto.
- [ ] Quorum continúa `true`.
- [ ] El reloj o la ronda vuelve a avanzar.
- [ ] Una respuesta enviada después de la caída es procesada.

### Después

- [ ] Se ejecutó `recover` o `up` en la laptop caída.
- [ ] Los tres nodos volvieron a `healthy`.
- [ ] Cada nodo ve dos peers.
- [ ] No se ejecutará otra caída hasta recuperar quorum completo.