<#
.SYNOPSIS
    Stop ZERO on Windows - and only what this deployment started.

.DESCRIPTION
    Every process stopped here was started by these scripts and is named in a
    pid file under .zero\run. Before anything is touched, the pid is checked
    against the process actually wearing it: Windows recycles pids, and the
    process holding one now may be something the operator cares about.

    There is no `taskkill /F /IM python.exe` here, and there never will be. A
    name-matched kill on a development laptop takes down whatever else happens
    to be running - a build, an editor's language server, someone's notebook.

    Graceful first, force only after a timeout, and only for a process that has
    already proved it is ours.
#>
[CmdletBinding()]
param([int]$GraceSeconds = 5)

. (Join-Path $PSScriptRoot 'lib-zero.ps1')
$ErrorActionPreference = 'Continue'

$paths = Get-ZeroPaths
Write-ZeroStep 'ZERO STOP'

$stopped = 0
# The supervisor first: it would otherwise notice the backend dying and
# helpfully restart it while we are trying to stop everything.
foreach ($entry in @(
        @{ Name = 'supervisor'; Path = $paths.SupervisorPid; Kind = 'supervisor' },
        @{ Name = 'gateway'; Path = $paths.GatewayPid; Kind = 'gateway' },
        @{ Name = 'hwd-zero'; Path = $paths.ZeroPid; Kind = 'hwd-zero' }
    )) {
    $result = Stop-ZeroTracked -PidFile $entry.Path -Name $entry.Name -Kind $entry.Kind -GraceSeconds $GraceSeconds
    switch ($result.Reason) {
        'stopped' {
            Write-ZeroOk "$($entry.Name) stopped (pid $($result.ProcessId))"
            $stopped++
        }
        'stale' { Write-ZeroWarn "$($entry.Name) pid file was stale - removed, nothing killed" }
        'foreign' {
            # The pid was recycled. Whatever is wearing it now is not ours.
            Write-ZeroWarn "$($entry.Name) pid $($result.ProcessId) belongs to another process - left alone"
        }
        default { }
    }
}

if ($stopped -eq 0) {
    Write-Host '  nothing that these scripts started was running'
}
Write-Host ''
exit 0
