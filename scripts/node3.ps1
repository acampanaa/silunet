$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:PEERS)) {
  throw 'Define PEERS con las URLs LAN de node1 y node2; no uses localhost entre computadoras.'
}
if ([string]::IsNullOrWhiteSpace($env:PUBLIC_NODES)) {
  throw 'Define PUBLIC_NODES con las tres URLs HTTP LAN.'
}

$env:NODE_ID = 'node3'
$env:PORT = '3001'
$env:COORDINATOR_ID = 'node1'
node $PSScriptRoot\..\dist\server.js
