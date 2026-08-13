$ErrorActionPreference = "Stop"

$env:NODE_ID        = "host-p2p"
$env:PORT           = "3001"
$env:COORDINATOR_ID = "host-p2p"
$env:PEERS          = ""
$env:PUBLIC_NODES   = ""
node "$PSScriptRoot\..\dist\server.js"
