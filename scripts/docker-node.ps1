[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'restart', 'status', 'logs', 'info')]
  [string]$Action = 'up',

  [string]$EnvFile = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repoRoot 'compose.node.yaml'
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  $EnvFile = Join-Path $repoRoot '.env.node'
}
$envPath = [IO.Path]::GetFullPath($EnvFile)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker no esta instalado o no esta disponible en PATH.'
}
if (-not (Test-Path -LiteralPath $envPath)) {
  throw "No existe $envPath. Ejecuta primero scripts/configure-docker-node.ps1."
}

$compose = @('compose', '--env-file', $envPath, '-f', $composeFile)

function Invoke-Docker([string[]]$CommandArgs) {
  & docker @CommandArgs
  if ($LASTEXITCODE -ne 0) { throw "Docker termino con codigo $LASTEXITCODE." }
}

switch ($Action) {
  'up' {
    Invoke-Docker ($compose + @('up', '-d', '--build'))
    Invoke-Docker ($compose + @('ps'))
    Write-Host 'Nodo listo en http://<IP-de-esta-maquina>:3001' -ForegroundColor Green
  }
  'down' {
    Invoke-Docker ($compose + @('down'))
    Write-Host 'Nodo detenido. El volumen con la replica se conserva.' -ForegroundColor Yellow
  }
  'restart' {
    Invoke-Docker ($compose + @('restart', 'node'))
  }
  'status' {
    Invoke-Docker ($compose + @('ps'))
  }
  'logs' {
    Invoke-Docker ($compose + @('logs', '--tail', '120', 'node'))
  }
  'info' {
    Invoke-Docker ($compose + @('exec', '-T', 'node', 'wget', '-q', '-O-', 'http://127.0.0.1:3001/api/info'))
  }
}
