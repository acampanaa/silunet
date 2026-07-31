$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
  throw "Define DATABASE_URL con la conexión PostgreSQL compartida antes de arrancar el clúster."
}

$env:NODE_ID        = "node3"
$env:PORT           = "3003"
$env:COORDINATOR_ID = "node1"
$env:PEERS          = "ws://localhost:3001,ws://localhost:3002"
node "$PSScriptRoot\..\dist\server.js"
