<#
.SYNOPSIS
    What is actually up, right now.

.DESCRIPTION
    Every line is read from the running system rather than inferred from a pid
    file: a process can be alive and not serving, and that difference is the
    whole reason to look. Prints no token and no secret.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib-zero.ps1')
$ErrorActionPreference = 'Continue'

$paths = Get-ZeroPaths
$config = Get-ZeroConfig -Root $paths.Root

function Show-Line {
    param([string]$Label, [string]$Value, [string]$Extra = '')
    $text = '{0,-14}{1}' -f $Label, $Value
    if ($Extra) { $text = "$text   $Extra" }
    Write-Host "  $text"
}

Write-Host ''
Write-Host 'HWD | ZERO - STATUS (windows)'
Write-Host ''
Show-Line 'ROOT' $paths.Root
Show-Line 'WORKSPACE' $paths.Workspace
Show-Line 'RUNTIME DIR' $paths.RuntimeDir
Write-Host ''

foreach ($entry in @(
        @{ Name = 'GATEWAY'; Path = $paths.GatewayPid; Port = $config.UiPort },
        @{ Name = 'HWD-ZERO'; Path = $paths.ZeroPid; Port = $config.ApiPort },
        @{ Name = 'SUPERVISOR'; Path = $paths.SupervisorPid; Port = 0 }
    )) {
    $processId = Get-ZeroLivePid -Path $entry.Path
    $state = 'STOPPED'
    $detail = ''
    if ($null -ne $processId) {
        $state = "RUNNING  pid $processId"
        if ($entry.Port -gt 0) { $detail = "port $($entry.Port)" }
    } elseif (Test-Path -LiteralPath $entry.Path) {
        $state = 'STALE PID FILE'
    }
    Show-Line $entry.Name $state $detail
}

Write-Host ''
$summary = Get-ZeroRuntimeSummary -Config $config -Paths $paths
Show-Line 'INTERFACE' $summary.Interface
Show-Line 'GATEWAY' $summary.Gateway
Show-Line 'HWD-ZERO' $summary.Backend
Show-Line 'ZERO RUNTIME' $summary.Runtime
Show-Line 'EVENT STREAM' $summary.EventStream
Show-Line 'REASONING' $summary.Reasoning
Show-Line 'WHISPER' $summary.Whisper
Show-Line 'WHISPER MODEL' $summary.WhisperModel
Show-Line 'STT' $summary.Stt
Show-Line 'VOICE' $summary.Voice
Show-Line 'AGENTS' $summary.Agents
Show-Line 'SUPERVISOR' $summary.Supervisor
Write-Host ''

if ($summary.Online) { exit 0 }
exit 1
