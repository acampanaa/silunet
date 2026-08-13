$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
  throw "Define DATABASE_URL con la conexión PostgreSQL compartida antes de arrancar el clúster."
}
if ([string]::IsNullOrWhiteSpace($env:PEERS)) {
  throw "Define PEERS con las URLs LAN de node1 y node2; no uses localhost entre computadoras."
}
if ([string]::IsNullOrWhiteSpace($env:PUBLIC_NODES)) {
  throw "Define PUBLIC_NODES con las tres URLs HTTP LAN para el failover de master y celulares."
}

$env:NODE_ID        = "node3"
$env:PORT           = "3003"
$env:COORDINATOR_ID = "node1"
node "$PSScriptRoot\..\dist\server.js"
