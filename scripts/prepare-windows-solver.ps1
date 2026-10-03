param(
    [Parameter(Mandatory=$true)][string]$SolverExecutable,
    [Parameter(Mandatory=$true)][string]$RuntimeDirectory,
    [string]$Destination = (Join-Path $PSScriptRoot '../data/solver')
)
$ErrorActionPreference = 'Stop'
$sources = @((Resolve-Path -LiteralPath $SolverExecutable).Path)
foreach ($name in @('libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll')) {
    $sources += (Resolve-Path -LiteralPath (Join-Path $RuntimeDirectory $name)).Path
}
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
foreach ($source in $sources) {
    $target = Join-Path $destinationPath (Split-Path -Leaf $source)
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
            throw "Destination contains a different file; choose a new directory: $target"
        }
    } else { Copy-Item -LiteralPath $source -Destination $target }
}
$env:PACKINGSOLVER_PATH = Join-Path $destinationPath (Split-Path -Leaf $sources[0])
Write-Output "Solver bundle prepared: $env:PACKINGSOLVER_PATH"
Write-Output 'PACKINGSOLVER_PATH is set for this PowerShell session. Start the application from this session.'
