[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'restart', 'status', 'logs', 'tunnel', 'fire', 'recover')]
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
  'fire' {
    $gatewayInfoUrl = 'http://127.0.0.1:8080/api/info'
    $before = Invoke-RestMethod -Uri $gatewayInfoUrl -TimeoutSec 5
    $failedNode = [string]$before.coordinator
    if ($failedNode -notin @('node1', 'node2', 'node3')) {
      throw "El gateway devolvio un coordinador invalido: '$failedNode'."
    }

    Write-Host "Prueba de fuego: derribando inmediatamente $failedNode..." -ForegroundColor Yellow
    Invoke-Docker ($compose + @('kill', $failedNode))
    $startedAt = Get-Date
    $deadline = $startedAt.AddSeconds(20)
    $after = $null
    do {
      Start-Sleep -Milliseconds 400
      try {
        $candidate = Invoke-RestMethod -Uri $gatewayInfoUrl -TimeoutSec 2
        if ($candidate.quorumAvailable -and $candidate.coordinator -ne $failedNode) {
          $after = $candidate
        }
      } catch {
        # El gateway puede responder 502 durante el instante exacto de la caida.
      }
    } while ($null -eq $after -and (Get-Date) -lt $deadline)

    if ($null -eq $after) {
      throw "No aparecio un coordinador sustituto en 20 segundos. Ejecuta: .\scripts\docker-cluster.ps1 logs"
    }

    $elapsedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
    Write-Host "OK: $failedNode cayo; $($after.coordinator) coordina con quorum (2/3) en ${elapsedMs}ms." -ForegroundColor Green
    Write-Host 'El gateway y la URL del tunnel no cambian. Los celulares se reconectan a la misma direccion.' -ForegroundColor Cyan
    Write-Host 'Al terminar la demostracion ejecuta: .\scripts\docker-cluster.ps1 recover' -ForegroundColor Yellow
  }
  'recover' {
    Invoke-Docker ($compose + @('up', '-d', '--no-build', 'node1', 'node2', 'node3'))
    Invoke-Docker ($compose + @('ps', 'node1', 'node2', 'node3'))
    Write-Host 'Los tres nodos fueron reintegrados; espera a que aparezcan healthy.' -ForegroundColor Green
  }
  'tunnel' {
    Invoke-Docker ($compose + @('--profile', 'tunnel', 'up', '-d', '--build'))
    Start-Sleep -Seconds 5
    Invoke-Docker ($compose + @('--profile', 'tunnel', 'logs', '--tail', '80', 'tunnel'))
    Write-Host 'Busca arriba la URL https://...trycloudflare.com' -ForegroundColor Cyan
  }
}
