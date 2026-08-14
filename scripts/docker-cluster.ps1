[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'restart', 'status', 'logs', 'tunnel')]
  [string]$Action = 'up'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repoRoot 'compose.cluster.yaml'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker no esta instalado o no esta disponible en PATH.'
}

$compose = @('compose', '-f', $composeFile)

function Invoke-Docker([string[]]$CommandArgs) {
  & docker @CommandArgs
  if ($LASTEXITCODE -ne 0) { throw "Docker termino con codigo $LASTEXITCODE." }
}

switch ($Action) {
  'up' {
    Invoke-Docker ($compose + @('up', '-d', '--build'))
    Invoke-Docker ($compose + @('ps'))
    Write-Host 'Jugadores: http://localhost:8080/join' -ForegroundColor Green
    Write-Host 'Pantalla maestra: http://localhost:8080/master' -ForegroundColor Green
  }
  'down' {
    Invoke-Docker ($compose + @('--profile', 'tunnel', 'down'))
    Write-Host 'Cluster detenido. Las replicas y PostgreSQL se conservan.' -ForegroundColor Yellow
  }
  'restart' {
    Invoke-Docker ($compose + @('restart', 'node1', 'node2', 'node3', 'gateway'))
  }
  'status' {
    Invoke-Docker ($compose + @('--profile', 'tunnel', 'ps'))
  }
  'logs' {
    Invoke-Docker ($compose + @('logs', '--tail', '120', 'node1', 'node2', 'node3', 'gateway'))
  }
  'tunnel' {
    Invoke-Docker ($compose + @('--profile', 'tunnel', 'up', '-d', '--build'))
    Start-Sleep -Seconds 5
    Invoke-Docker ($compose + @('--profile', 'tunnel', 'logs', '--tail', '80', 'tunnel'))
    Write-Host 'Busca arriba la URL https://...trycloudflare.com' -ForegroundColor Cyan
  }
}
