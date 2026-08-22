<#
.SYNOPSIS
    Keep HWD-ZERO alive behind the gateway, on Windows.

.DESCRIPTION
    The Windows counterpart of scripts/zero-supervise.sh, and deliberately as
    narrow as it is:

      - It supervises HWD-ZERO only. The gateway needs no supervisor - it
        survives an absent backend by design, and a second process able to
        restart it would be a second process able to take port 3000 away.
      - It exits the moment the gateway does, so a stopped ZERO does not leave
        an orphan loop respawning a backend nobody is talking to.
      - Restarts back off: 1s, 2s, 5s, 10s, then 15s, and no further. A backend
        that dies instantly over and over is a broken install; hammering it
        hides the error and, on a laptop, spends the battery doing it.
      - It never starts a second HWD-ZERO. Before restarting it asks port 8000
        who is there: an HWD-ZERO already answering is adopted, not duplicated.
      - It never stops anything it did not start, and never matches by name.

    Started by zero-windows-start.ps1; not meant to be run by hand.
#>
[CmdletBinding()]
param(
    [string]$StartCommand = '',
    [int]$IntervalSeconds = 10,
    [int]$MaxRestarts = 5,
    [int]$WindowSeconds = 300,
    # A cold HWD-ZERO loads the brain before it binds. Judging it dead during
    # that is how one slow start becomes a restart loop.
    [int]$GraceSeconds = 10
)

. (Join-Path $PSScriptRoot 'lib-zero.ps1')
$ErrorActionPreference = 'Continue'

$paths = Get-ZeroPaths
$config = Get-ZeroConfig -Root $paths.Root
if (-not $StartCommand) {
    # Written by the start script. A file rather than a command-line argument
    # because the command contains spaces and paths, and one lost quote turns
    # `python -m zero.server ...` into `python` with no error anywhere.
    $commandFile = Join-Path $paths.RunDir 'supervise.cmd'
    if (Test-Path -LiteralPath $commandFile) {
        $stored = Get-Content -LiteralPath $commandFile -Raw
        if ($stored) { $StartCommand = $stored.Trim() }
    }
}
if (-not $StartCommand) { $StartCommand = $env:ZERO_SUPERVISE_CMD }

Set-Content -LiteralPath $paths.SupervisorPid -Value $PID -Encoding ascii

function Write-SupervisorLog {
    param([string]$Message)
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    Add-Content -LiteralPath $paths.SupervisorLog -Value "$stamp  $Message"
}

if (-not $StartCommand) {
    Write-SupervisorLog 'no start command given - nothing to supervise'
    Remove-Item -LiteralPath $paths.SupervisorPid -Force -ErrorAction SilentlyContinue
    exit 0
}

Write-SupervisorLog "supervising HWD-ZERO every ${IntervalSeconds}s (grace ${GraceSeconds}s): $StartCommand"

function Test-BackendAlive {
    # Alive means both: the process exists *and* it is answering. A python
    # process stuck on a port it never bound is not a running backend.
    if ($null -eq (Get-ZeroLivePid -Path $paths.ZeroPid)) { return $false }
    return (Test-ZeroHttp -Url "$($config.ApiUrl)/api/health" -TimeoutSec 3)
}

function Invoke-Adoption {
    <#
        Is an HWD-ZERO already on the port that this supervisor lost track of?

        It happens: a pid file removed by hand, a restarted supervisor, a
        backend started from another terminal. Adopting it is right and
        starting a second is wrong - the second would fail to bind and take
        the confusion out on the first.
    #>
    $running = Get-ZeroServiceOnPort -Port $config.ApiPort
    if ($null -eq $running) { return $false }
    Set-Content -LiteralPath $paths.ZeroPid -Value $running.ProcessId -Encoding ascii
    Write-SupervisorLog "adopted the HWD-ZERO already serving port $($config.ApiPort) (pid $($running.ProcessId))"
    return $true
}

function Split-StartCommand {
    <# Split a command line, respecting double quotes around a path. #>
    param([string]$Command)
    $parts = @()
    foreach ($match in [regex]::Matches($Command, '"([^"]*)"|(\S+)')) {
        if ($match.Groups[1].Success) { $parts += $match.Groups[1].Value }
        else { $parts += $match.Groups[2].Value }
    }
    return $parts
}

function Start-Backend {
    $parts = Split-StartCommand -Command $StartCommand
    if ($parts.Count -eq 0) { return 0 }
    $file = $parts[0]
    $rest = @()
    if ($parts.Count -gt 1) { $rest = $parts[1..($parts.Count - 1)] }
    $process = Start-ZeroBackground -FilePath $file -ArgumentList $rest `
        -WorkingDirectory $paths.RuntimeDir -LogFile $paths.ZeroLog `
        -Environment @{ ZERO_LOG_DIR = $paths.LogDir; ZERO_VOICE_LOG = $paths.VoiceLog }
    if ($process) {
        # The real child, never a shell that launched it: a wrapper pid here
        # means stopping ZERO leaves the actual server running and untracked.
        Set-Content -LiteralPath $paths.ZeroPid -Value $process.Id -Encoding ascii
        return $process.Id
    }
    return 0
}

$restarts = 0
$windowStarted = Get-Date
$nextCheckAt = (Get-Date)
if (Test-Path -LiteralPath $paths.ZeroPid) { $nextCheckAt = (Get-Date).AddSeconds($GraceSeconds) }

try {
    while ($true) {
        Start-Sleep -Seconds $IntervalSeconds

        # The gateway is the anchor. When it is gone, ZERO is stopped, and this
        # loop has nothing left to keep alive.
        if ($null -eq (Get-ZeroLivePid -Path $paths.GatewayPid)) {
            Write-SupervisorLog 'gateway is gone - supervisor exiting'
            break
        }

        if (Test-BackendAlive) {
            $restarts = 0
            $nextCheckAt = Get-Date
            continue
        }

        $now = Get-Date
        # Still inside the grace period or a backoff wait. Not a failure yet.
        if ($now -lt $nextCheckAt) { continue }

        if (Invoke-Adoption) {
            $restarts = 0
            continue
        }

        if (($now - $windowStarted).TotalSeconds -ge $WindowSeconds) {
            # A fresh window: earlier failures are old news.
            $restarts = 0
            $windowStarted = $now
        }

        if ($restarts -ge $MaxRestarts) {
            Write-SupervisorLog "HWD-ZERO has failed $restarts times in ${WindowSeconds}s - giving up."
            Write-SupervisorLog "the interface stays up and reports BACKEND OFFLINE; see $($paths.ZeroLog)"
            break
        }

        $restarts++
        $wait = Get-ZeroBackoffSeconds -Attempt $restarts
        Write-SupervisorLog "HWD-ZERO is not answering - restart $restarts/$MaxRestarts, next check in ${wait}s (+${GraceSeconds}s grace)"
        $started = Start-Backend
        if ($started -eq 0) { Write-SupervisorLog 'the restart could not be launched' }
        # A floor on the next judgement, not a sleep: the loop stays responsive
        # to the gateway disappearing.
        $nextCheckAt = $now.AddSeconds($wait + $GraceSeconds)
    }
} finally {
    Remove-Item -LiteralPath $paths.SupervisorPid -Force -ErrorAction SilentlyContinue
}
exit 0
