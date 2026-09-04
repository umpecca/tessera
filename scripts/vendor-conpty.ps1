$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -Raw (Join-Path $repoRoot 'internal/terminalcore/source.json') | ConvertFrom-Json
$version = $manifest.conptyVersion
$cacheRoot = Join-Path $repoRoot '.cache/conpty'
New-Item -ItemType Directory -Force $cacheRoot | Out-Null
$archive = Join-Path $cacheRoot "$version.zip"
Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$version/microsoft.windows.console.conpty.$version.nupkg" -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.conptyPackageSHA256) { throw 'ConPTY package checksum differs' }
$expanded = Join-Path $cacheRoot $version
Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
foreach ($pair in @(@('amd64','x64'), @('arm64','arm64'), @('386','x86'))) {
    $destination = Join-Path $repoRoot "internal/winconpty/assets/$($pair[0])"
    New-Item -ItemType Directory -Force $destination | Out-Null
    Copy-Item -LiteralPath (Join-Path $expanded "runtimes/win-$($pair[1])/native/conpty.dll") -Destination $destination
    Copy-Item -LiteralPath (Join-Path $expanded "build/native/runtimes/$($pair[1])/OpenConsole.exe") -Destination $destination
}
