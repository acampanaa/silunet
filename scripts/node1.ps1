$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) {
  throw "Define DATABASE_URL con la conexión PostgreSQL compartida antes de arrancar el clúster."
}

$env:NODE_ID        = "node1"
$env:PORT           = "3001"
$env:COORDINATOR_ID = "node1"
$env:PEERS          = ""
node "$PSScriptRoot\..\dist\server.js"
