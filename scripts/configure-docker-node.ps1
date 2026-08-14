[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('node1', 'node2', 'node3')]
  [string]$NodeId,

  [Parameter(Mandatory)]
  [string]$Node1Host,

  [Parameter(Mandatory)]
  [string]$Node2Host,

  [Parameter(Mandatory)]
  [string]$Node3Host,

  [ValidateRange(1, 65535)]
  [int]$Port = 3001,

  [string]$DatabaseUrl = '',
  [string]$OutputFile = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputFile)) {
  $OutputFile = Join-Path $repoRoot '.env.node'
}

function Assert-HostValue([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[,\s/]' ) {
    throw "$Name debe ser una IP o nombre DNS sin protocolo, puerto, comas ni espacios."
  }
}

Assert-HostValue 'Node1Host' $Node1Host
Assert-HostValue 'Node2Host' $Node2Host
Assert-HostValue 'Node3Host' $Node3Host

$nodeHosts = [ordered]@{
  node1 = $Node1Host.Trim()
  node2 = $Node2Host.Trim()
  node3 = $Node3Host.Trim()
}

$peerUrls = @(
  $nodeHosts.GetEnumerator() |
    Where-Object { $_.Key -ne $NodeId } |
    ForEach-Object { "ws://$($_.Value):$Port" }
) -join ','

$publicUrls = @(
  $nodeHosts.GetEnumerator() |
    ForEach-Object { "http://$($_.Value):$Port" }
) -join ','

$lines = @(
  "COMPOSE_PROJECT_NAME=silunet-$NodeId"
  "NODE_ID=$NodeId"
  'COORDINATOR_ID=node1'
  "HOST_PORT=$Port"
  'BIND_IP=0.0.0.0'
  "PEERS=$peerUrls"
  "PUBLIC_NODES=$publicUrls"
  "DATABASE_URL=$DatabaseUrl"
  'DB_POOL_SIZE=5'
  'CLUSTER_ID=silunet-main'
)

$fullOutput = [IO.Path]::GetFullPath($OutputFile)
$parent = Split-Path -Parent $fullOutput
if (-not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}
[IO.File]::WriteAllLines($fullOutput, $lines, [Text.UTF8Encoding]::new($false))

Write-Host "Configuracion creada para $NodeId en $fullOutput" -ForegroundColor Green
Write-Host "Peers: $peerUrls"
Write-Host "URLs publicas: $publicUrls"
Write-Host ''
Write-Host 'Siguiente paso:' -ForegroundColor Cyan
Write-Host "  .\scripts\docker-node.ps1 up -EnvFile `"$fullOutput`""
