[CmdletBinding()]
param(
  [string]$SourceRoot = "",
  [string]$OutputDirectory = "",
  [switch]$SkipPrepublish
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-FullPath([string]$PathValue) {
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Assert-PathInside([string]$ChildPath, [string]$ParentPath, [string]$Label) {
  $child = Get-FullPath $ChildPath
  $parent = (Get-FullPath $ParentPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $prefix = $parent + [System.IO.Path]::DirectorySeparatorChar
  if (-not $child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside $parent (resolved: $child)."
  }
}

function Assert-File([string]$PathValue, [string]$Label) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    throw "Missing $Label at $PathValue"
  }
  if ((Get-Item -LiteralPath $PathValue).Length -le 0) {
    throw "$Label is empty at $PathValue"
  }
}

function Relative-Path([string]$Root, [string]$PathValue) {
  $rootPrefix = (Get-FullPath $Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  return (Get-FullPath $PathValue).Substring($rootPrefix.Length).Replace("\", "/")
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Join-Path $PSScriptRoot ".."
}
$source = Get-FullPath $SourceRoot
Assert-File (Join-Path $source "manifest.json") "manifest"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $source "dist"
}
$output = Get-FullPath $OutputDirectory
if (-not (Test-Path -LiteralPath $output)) {
  New-Item -ItemType Directory -Path $output | Out-Null
}
$output = (Resolve-Path -LiteralPath $output).Path

if (-not $SkipPrepublish) {
  Assert-File (Join-Path $source "scripts\prepublish-check.mjs") "prepublish gate"
  Push-Location $source
  try {
    & node "scripts\prepublish-check.mjs"
    if ($LASTEXITCODE -ne 0) {
      throw "The prepublish gate failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

$manifest = Get-Content -LiteralPath (Join-Path $source "manifest.json") -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+(?:\.\d+){0,3}$') {
  throw "Manifest version is invalid for a Chrome extension release: $version"
}

$artifactBase = "BlackboardSearchExtension-$version"
$unpacked = Join-Path $output ($artifactBase + "-unpacked")
$zipPath = Join-Path $output ($artifactBase + ".zip")
Assert-PathInside $unpacked $output "Unpacked artifact"
Assert-PathInside $zipPath $output "ZIP artifact"

if (Test-Path -LiteralPath $unpacked) {
  if ((Split-Path -Leaf $unpacked) -ne ($artifactBase + "-unpacked")) {
    throw "Refusing to replace unexpected unpacked path: $unpacked"
  }
  Remove-Item -LiteralPath $unpacked -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  if ((Split-Path -Leaf $zipPath) -ne ($artifactBase + ".zip")) {
    throw "Refusing to replace unexpected ZIP path: $zipPath"
  }
  Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $unpacked | Out-Null

$runtimeDirectories = @("assets", "background", "content", "lib", "resource-packs", "sidepanel")
foreach ($directory in $runtimeDirectories) {
  $sourceDirectory = Join-Path $source $directory
  if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
    throw "Missing runtime directory: $sourceDirectory"
  }
  Copy-Item -LiteralPath $sourceDirectory -Destination (Join-Path $unpacked $directory) -Recurse -Force
}

foreach ($fileName in @("manifest.json", "README.md", "PRIVACY.md")) {
  $sourceFile = Join-Path $source $fileName
  Assert-File $sourceFile $fileName
  Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $unpacked $fileName) -Force
}

$allowedTopLevel = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@("assets", "background", "content", "lib", "resource-packs", "sidepanel", "manifest.json", "README.md", "PRIVACY.md") |
  ForEach-Object { [void]$allowedTopLevel.Add($_) }

$packagedFiles = @(Get-ChildItem -LiteralPath $unpacked -File -Recurse)
if (-not $packagedFiles.Count) {
  throw "The unpacked artifact contains no files."
}
$relativeFiles = @($packagedFiles | ForEach-Object { Relative-Path $unpacked $_.FullName } | Sort-Object)

foreach ($relative in $relativeFiles) {
  $top = $relative.Split('/')[0]
  if (-not $allowedTopLevel.Contains($top)) {
    throw "Unexpected top-level release entry: $relative"
  }
  if ($relative -match '(?i)(?:^|/)(?:scripts|fixtures|sample-data|dist|node_modules|\.git)(?:/|$)' -or
      $relative -match '(?i)(?:answer-key|holdout|questions\.json|\.env(?:\.|$)|secrets?)') {
    throw "Forbidden evaluation, development, or secret-like path in release: $relative"
  }
}

$requiredFiles = @(
  "manifest.json",
  "assets/icons/icon16.png",
  "assets/icons/icon32.png",
  "assets/icons/icon48.png",
  "assets/icons/icon128.png",
  "background/service-worker.js",
  "content/scraper.js",
  "lib/answer-formatting.js",
  "lib/blackboard-session.js",
  "lib/llm-client.js",
  "lib/pdf.min.js",
  "lib/pdf.worker.min.js",
  "lib/search-index.js",
  "sidepanel/sidepanel.css",
  "sidepanel/sidepanel.html",
  "sidepanel/sidepanel.js",
  "resource-packs/schwarzman-c11/pack.json"
)
foreach ($relative in $requiredFiles) {
  Assert-File (Join-Path $unpacked $relative.Replace('/', '\')) "required release file $relative"
}

$manifestPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
[void]$manifestPaths.Add([string]$manifest.background.service_worker)
[void]$manifestPaths.Add([string]$manifest.side_panel.default_path)
foreach ($scriptGroup in @($manifest.content_scripts)) {
  foreach ($scriptPath in @($scriptGroup.js)) {
    [void]$manifestPaths.Add([string]$scriptPath)
  }
}
foreach ($property in @($manifest.icons.PSObject.Properties)) {
  [void]$manifestPaths.Add([string]$property.Value)
}
foreach ($property in @($manifest.action.default_icon.PSObject.Properties)) {
  [void]$manifestPaths.Add([string]$property.Value)
}
foreach ($relative in $manifestPaths) {
  Assert-File (Join-Path $unpacked $relative.Replace('/', '\')) "manifest-referenced file $relative"
}

$packRoot = Join-Path $unpacked "resource-packs\schwarzman-c11"
$packManifestPath = Join-Path $packRoot "pack.json"
$pack = Get-Content -LiteralPath $packManifestPath -Raw | ConvertFrom-Json
if ([string]$pack.id -ne "schwarzman-c11" -or @($pack.resources).Count -lt 1) {
  throw "The Schwarzman C11 pack manifest is missing, empty, or has the wrong ID."
}
foreach ($resource in @($pack.resources)) {
  foreach ($fieldName in @("text_url", "url")) {
    $relative = [string]$resource.$fieldName
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '^[a-z][a-z0-9+.-]*:') {
      continue
    }
    $resolved = Get-FullPath (Join-Path $packRoot $relative.Replace('/', '\'))
    Assert-PathInside $resolved $packRoot "Pack resource path"
    Assert-File $resolved "pack resource $relative"
  }
}

$secretPatterns = @(
  '(?i)\bsk-[a-z0-9_-]{20,}\b',
  '(?i)\b(?:OPENAI|OPENROUTER|DEEPSEEK)_API_KEY\s*=\s*["'']?[^\s"'']+',
  '(?i)Authorization\s*[:=]\s*["'']?Bearer\s+[a-z0-9._-]{20,}',
  '(?i)\btest-key\b'
)
$textExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(".js", ".html", ".css", ".json", ".md", ".txt") | ForEach-Object { [void]$textExtensions.Add($_) }
foreach ($file in $packagedFiles) {
  if (-not $textExtensions.Contains($file.Extension)) {
    continue
  }
  $text = Get-Content -LiteralPath $file.FullName -Raw
  foreach ($pattern in $secretPatterns) {
    if ($text -match $pattern) {
      throw "Secret-like material matched in packaged file: $(Relative-Path $unpacked $file.FullName)"
    }
  }
}

$syntaxFiles = @(
  "background/service-worker.js",
  "content/scraper.js",
  "lib/answer-formatting.js",
  "lib/blackboard-session.js",
  "lib/llm-client.js",
  "lib/search-index.js",
  "sidepanel/sidepanel.js"
)
foreach ($relative in $syntaxFiles) {
  & node --check (Join-Path $unpacked $relative.Replace('/', '\'))
  if ($LASTEXITCODE -ne 0) {
    throw "Packaged JavaScript syntax check failed: $relative"
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $unpacked,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)
Assert-File $zipPath "release ZIP"

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $zipEntries = @($zip.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) } |
    ForEach-Object { $_.FullName.Replace("\", "/") } | Sort-Object)
} finally {
  $zip.Dispose()
}
$entryDiff = @(Compare-Object -ReferenceObject $relativeFiles -DifferenceObject $zipEntries)
if ($entryDiff.Count) {
  throw "ZIP entries do not exactly match the verified unpacked artifact: $($entryDiff | Out-String)"
}

$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$packFileCount = @($relativeFiles | Where-Object { $_ -like 'resource-packs/schwarzman-c11/*' }).Count

Write-Host "Release artifact passed all checks."
Write-Host "Version: $version"
Write-Host "Files: $($relativeFiles.Count)"
Write-Host "Schwarzman C11 pack files: $packFileCount"
Write-Host "Unpacked: $unpacked"
Write-Host "ZIP: $zipPath"
Write-Host "SHA-256: $zipHash"

[PSCustomObject]@{
  version = $version
  file_count = $relativeFiles.Count
  schwarzman_pack_file_count = $packFileCount
  unpacked_path = $unpacked
  zip_path = $zipPath
  sha256 = $zipHash
}
