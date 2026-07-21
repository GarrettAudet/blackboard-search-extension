[CmdletBinding()]
param(
  [string]$EnvironmentFile = "C:\repos\BlackboardSearchExtension\.env",
  [string]$OutputPath = "",
  [switch]$ConfirmProviderSpend
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ConfirmProviderSpend) {
  throw "This paid benchmark requires -ConfirmProviderSpend. The hard ceiling is 132 logical completions."
}

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
  throw "Environment file was not found: $EnvironmentFile"
}

function Read-OpenRouterCredential([string]$Path) {
  $matches = @(
    [System.IO.File]::ReadLines((Resolve-Path -LiteralPath $Path).Path) |
      Where-Object { $_ -match '^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=' }
  )
  if ($matches.Count -ne 1) {
    throw "The environment file must contain exactly one OPENROUTER_API_KEY assignment."
  }

  $value = [regex]::Replace(
    [string]$matches[0],
    '^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*',
    ''
  )
  $value = [regex]::Replace($value, '\A[\s\p{Z}\p{C}]+|[\s\p{Z}\p{C}]+\z', '')
  if ($value.Length -ge 2) {
    $first = $value[0]
    $last = $value[$value.Length - 1]
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $value = $value.Substring(1, $value.Length - 2)
      $value = [regex]::Replace($value, '\A[\s\p{Z}\p{C}]+|[\s\p{Z}\p{C}]+\z', '')
    }
  }
  if ([string]::IsNullOrEmpty($value) -or $value -cnotmatch '\A[\x21-\x7E]+\z') {
    throw "OPENROUTER_API_KEY is empty or contains whitespace/invisible formatting characters."
  }
  return $value
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
  $OutputPath = Join-Path ([System.IO.Path]::GetTempPath()) "v3-live-$stamp-$suffix.json"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) {
  throw "Every live run must use a new output path: $OutputPath"
}

$previousKey = [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "Process")
$pushed = $false
try {
  $credential = Read-OpenRouterCredential -Path $EnvironmentFile
  [Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", $credential, "Process")
  $credential = $null

  Write-Host "Frozen V3: 20 answerable cases + 2 unanswerable controls"
  Write-Host "Generation: openrouter / openai/gpt-4.1-mini"
  Write-Host "Judge:      openrouter / google/gemini-2.5-flash"
  Write-Host "Hard ceiling: 132 logical completions"
  Write-Host "Private report: $OutputPath"

  Push-Location $root
  $pushed = $true
  $jsonLines = & node scripts\live-holdout-eval.mjs `
    --suite v3 `
    --seed fixed-v3-production-2026-07-21 `
    --repeats 1 `
    --provider openrouter `
    --model openai/gpt-4.1-mini `
    --judge `
    --judge-provider openrouter `
    --judge-model google/gemini-2.5-flash `
    --max-logical-completions 132 `
    --max-provider-calls 6 `
    --max-p50-ms 30000 `
    --max-p95-ms 50000 `
    --details `
    --json
  $nodeExit = $LASTEXITCODE
  $jsonLines | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  $report = ($jsonLines -join "`n") | ConvertFrom-Json

  Write-Host ""
  Write-Host ("Answerable end-to-end: {0:P1} ({1}/{2} completed)" -f `
    [double]$report.metrics.answerable_cases.end_to_end_accuracy, `
    [int]$report.metrics.answerable_cases.completed_executions, `
    [int]$report.metrics.answerable_cases.executions)
  Write-Host ("Unanswerable controls: {0:P1} ({1}/{2} completed)" -f `
    [double]$report.metrics.unanswerable_controls.correct_abstention_rate, `
    [int]$report.metrics.unanswerable_controls.completed_executions, `
    [int]$report.metrics.unanswerable_controls.executions)
  Write-Host ("Grounding: {0:P1}; contradictions: {1:P1}" -f `
    [double]$report.metrics.answerable_cases.grounding_pass_rate, `
    [double]$report.metrics.contradiction_rate)
  Write-Host ("Pipeline latency p50/p95: {0:N0}/{1:N0} ms" -f `
    [double]$report.metrics.production_pipeline_latency_p50_ms, `
    [double]$report.metrics.production_pipeline_latency_p95_ms)
  Write-Host ("Provider calls avg/p95: {0:N1}/{1:N0}; logical completions used: {2}" -f `
    [double]$report.metrics.production_provider_calls_average, `
    [double]$report.metrics.production_provider_calls_p95, `
    [int]$report.logical_completions_used)
  Write-Host ("Release gate: {0}" -f $(if ($report.gate.passed) { "PASS" } else { "FAIL" }))
  if ($report.gate.failures.Count -gt 0) {
    Write-Host ("Gate failures: " + ($report.gate.failures -join "; "))
  }
  if ($report.zero_pass_case_ids.Count -gt 0) {
    Write-Host ("Failed opaque IDs: " + ($report.zero_pass_case_ids -join ", "))
  }

  if ($nodeExit -ne 0) {
    throw "V3 completed but did not pass its release gate. The private report is at $OutputPath"
  }
} finally {
  if ($pushed) { Pop-Location }
  [Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", $previousKey, "Process")
}
