<#
.SYNOPSIS
    Start ZERO on Windows 11: the gateway first, then HWD-ZERO behind it.

.DESCRIPTION
    The rule this script exists to enforce is the same one the Termux script
    enforces, because it is not a platform detail:

        THE GATEWAY STARTS FIRST, AND NOTHING ABOUT THE BACKEND CAN STOP IT.

    Port 3000 is what the operator looks at. If HWD-ZERO is missing, broken,
    half-installed or merely slow, port 3000 must still answer and the
    interface must say BACKEND OFFLINE. A backend that is not running is a
    state to display, never a reason for the web server to disappear.

    So: build (a failure there is survivable), start the gateway, *prove* it
    answers, and only then go looking for HWD-ZERO. Everything below the
    gateway is advisory.

    Loopback only. Windows asks about public networks the moment something
    binds 0.0.0.0, and the interface has no business there unless asked.

.PARAMETER Lan
    Also serve on the LAN. Off by default and deliberately so.

.PARAMETER NoBackend
    Serve the interface alone. It will report BACKEND OFFLINE, correctly.

.PARAMETER NoSupervise
    Do not start the supervisor that restarts HWD-ZERO if it dies.

.PARAMETER NoBuild
    Skip the bundle build and serve whatever is in dist already.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\zero-windows-start.ps1
#>
[CmdletBinding()]
param(
    [switch]$Lan,
    [switch]$NoBackend,
    [switch]$NoSupervise,
    [switch]$NoBuild
)

. (Join-Path $PSScriptRoot 'lib-zero.ps1')

# Errors are decided one at a time here, where the right response is known.
# A blanket `Stop` would abandon the gateway over a failed optional step —
# which is precisely how the interface came to be skipped on the phone.
$ErrorActionPreference = 'Continue'

$paths = Get-ZeroPaths
$config = Get-ZeroConfig -Root $paths.Root
Set-Location -LiteralPath $paths.Root

# --------------------------------------------------------------------------
Write-ZeroStep '1 - WORKSPACE'
Write-ZeroOk "root       $($paths.Root)"
Write-ZeroOk "workspace  $($paths.Workspace)"
Write-ZeroOk "powershell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
if (Test-Path -LiteralPath (Join-Path $paths.RuntimeDir 'zero')) {
    Write-ZeroOk "hwd-zero   $($paths.RuntimeDir)"
} else {
    Write-ZeroWarn "hwd-zero   not checked out at $($paths.RuntimeDir)"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-ZeroBad 'node is not installed. Install Node.js 20.19+ and re-run.'
    Write-ZeroNote 'winget install --id OpenJS.NodeJS.LTS --scope user'
    exit 1
}
$nodeVersion = (& node -v)
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 20) {
    Write-ZeroBad "node $nodeVersion is too old - the gateway needs 20.19 or newer."
    exit 1
}
Write-ZeroOk "node       $nodeVersion"

$python = $null
foreach ($candidate in @(
        (Join-Path $paths.RuntimeDir '.venv\Scripts\python.exe'),
        'py', 'python', 'python3'
    )) {
    if ($candidate -like '*\*') {
        if (Test-Path -LiteralPath $candidate) { $python = $candidate; break }
    } elseif (Get-Command $candidate -ErrorAction SilentlyContinue) {
        $python = $candidate; break
    }
}
if ($python) {
    Write-ZeroOk "python     $(& $python --version 2>&1)"
} else {
    # Not fatal. Python is the backend's business, and the backend is optional.
    Write-ZeroWarn 'python     not found - HWD-ZERO cannot start (the interface still will)'
}

# --------------------------------------------------------------------------
Write-ZeroStep '2 - RUN STATE'
foreach ($entry in @(
        @{ Name = 'gateway'; Path = $paths.GatewayPid },
        @{ Name = 'hwd-zero'; Path = $paths.ZeroPid },
        @{ Name = 'supervisor'; Path = $paths.SupervisorPid }
    )) {
    if (Clear-ZeroStalePid -Path $entry.Path) {
        Write-ZeroWarn "removed a stale $($entry.Name) pid file - nothing was killed"
    }
}

$existing = Get-ZeroLivePid -Path $paths.GatewayPid
if ($null -ne $existing) {
    if (Test-ZeroHttp -Url $config.HealthUrl) {
        Write-ZeroOk "a ZERO gateway is already running (pid $existing) and answering"
        Write-ZeroNote "INTERFACE  $($config.InterfaceUrl)"
        Write-ZeroNote 'STOP       .\scripts\zero-windows-stop.ps1'
        exit 0
    }
    Write-ZeroWarn "gateway pid $existing is alive but not answering - replacing it"
    Stop-ZeroTracked -PidFile $paths.GatewayPid -Name 'gateway' -Kind 'gateway' | Out-Null
}

if (Test-ZeroPortBusy -Port $config.UiPort) {
    $owner = Get-ZeroPortOwner -Port $config.UiPort
    Write-ZeroBad "PORT $($config.UiPort) BLOCKED"
    if ($null -ne $owner) {
        Write-ZeroNote "PID        $($owner.ProcessId)"
        Write-ZeroNote "PROCESS    $($owner.ProcessName)"
    }
    Write-ZeroNote 'REASON     foreign process'
    Write-ZeroNote 'ZERO will not stop a process it did not start.'
    exit 1
}
Write-ZeroOk "port $($config.UiPort) is free"

# --------------------------------------------------------------------------
Write-ZeroStep '3 - INTERFACE BUNDLE'
$distIndex = Join-Path $paths.Root 'dist\index.html'
$needsBuild = -not (Test-Path -LiteralPath $distIndex)
if (-not $needsBuild -and -not $NoBuild) {
    $builtAt = (Get-Item -LiteralPath $distIndex).LastWriteTimeUtc
    $newer = Get-ChildItem -LiteralPath (Join-Path $paths.Root 'src') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1
    if ($newer) { $needsBuild = $true }
}
if ($NoBuild -and (Test-Path -LiteralPath $distIndex)) {
    Write-ZeroOk 'skipping the build (-NoBuild)'
} elseif ($needsBuild) {
    if (-not (Test-Path -LiteralPath (Join-Path $paths.Root 'node_modules'))) {
        Write-ZeroWarn 'installing dependencies (the slow part)'
        & npm install *>> $paths.BuildLog
    }
    Write-ZeroWarn 'building the interface'
    & npm run build *>> $paths.BuildLog
    if ($LASTEXITCODE -eq 0) {
        Write-ZeroOk 'built'
    } elseif (Test-Path -LiteralPath $distIndex) {
        # Serving a slightly stale interface beats serving nothing.
        Write-ZeroWarn 'build failed - serving the previous bundle instead'
        Get-ZeroLogTail -Path $paths.BuildLog -Lines 15 | ForEach-Object { Write-ZeroNote $_ }
    } else {
        Write-ZeroBad 'build failed and there is no previous bundle to serve'
        Get-ZeroLogTail -Path $paths.BuildLog -Lines 30 | ForEach-Object { Write-ZeroNote $_ }
        exit 1
    }
} else {
    Write-ZeroOk 'dist is current'
}

# --------------------------------------------------------------------------
Write-ZeroStep '4 - GATEWAY'
Remove-Item -LiteralPath $paths.GatewayLog -Force -ErrorAction SilentlyContinue
$lanMode = 'false'
if ($Lan) { $lanMode = 'true' }
$gateway = Start-ZeroBackground -FilePath $node.Source `
    -ArgumentList @((Join-Path $paths.Root 'server\gateway.mjs')) `
    -WorkingDirectory $paths.Root `
    -LogFile $paths.GatewayLog `
    -Environment @{
        ZERO_LAN_MODE       = $lanMode
        ZERO_UI_PORT        = [string]$config.UiPort
        ZERO_API_URL        = $config.ApiUrl
        ZERO_RUNTIME_WS_URL = $config.RuntimeWsUrl
    }
if (-not $gateway) {
    Write-ZeroBad 'the gateway process could not be started'
    exit 1
}
Set-Content -LiteralPath $paths.GatewayPid -Value $gateway.Id -Encoding ascii
Write-ZeroOk "gateway started (pid $($gateway.Id))"

# --------------------------------------------------------------------------
Write-ZeroStep '5 - GATEWAY HEALTH'
# Claiming ONLINE without checking is the bug this step exists to prevent.
$gatewayUp = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($gateway.HasExited) { break }
    if ((Test-ZeroHttp -Url "http://127.0.0.1:$($config.UiPort)/" -TimeoutSec 2) -and
        (Test-ZeroHttp -Url $config.HealthUrl -TimeoutSec 2)) {
        $gatewayUp = $true
        break
    }
    Start-Sleep -Milliseconds 500
}
if (-not $gatewayUp) {
    Write-ZeroBad "ZERO GATEWAY FAILED - port $($config.UiPort) did not answer"
    Get-ZeroLogTail -Path $paths.GatewayLog -Lines 30 | ForEach-Object { Write-ZeroNote $_ }
    Remove-Item -LiteralPath $paths.GatewayPid -Force -ErrorAction SilentlyContinue
    if (-not $gateway.HasExited) { try { Stop-Process -Id $gateway.Id -Force } catch { } }
    exit 1
}
Write-ZeroOk 'GET /            answers'
Write-ZeroOk 'GET /api/health  answers'

# --------------------------------------------------------------------------
Write-ZeroStep '6 - HWD-ZERO'
$backendExpected = $false
$superviseCommand = $null
$existingZero = Get-ZeroServiceOnPort -Port $config.ApiPort

if ($NoBackend) {
    Write-ZeroWarn 'skipped (-NoBackend); the interface will report BACKEND OFFLINE'
} elseif ($null -ne $existingZero) {
    # Identity, not "the port answers". Exactly one managed HWD-ZERO exists,
    # and an existing one is adopted rather than duplicated.
    Write-ZeroOk "already running at $($config.ApiUrl) (pid $($existingZero.ProcessId), version $($existingZero.Version)) - adopting it"
    Set-Content -LiteralPath $paths.ZeroPid -Value $existingZero.ProcessId -Encoding ascii
    $backendExpected = $true
    # An adopted backend still needs a restart command, or the supervisor has
    # nothing to do the first time it dies.
    if ($python -and (Test-Path -LiteralPath (Join-Path $paths.RuntimeDir 'zero'))) {
        $superviseCommand = "$python -m zero.server --host 127.0.0.1 --port $($config.ApiPort) --quiet"
    }
} elseif (Test-ZeroPortBusy -Port $config.ApiPort) {
    Write-ZeroBad "PORT $($config.ApiPort) BLOCKED"
    $owner = Get-ZeroPortOwner -Port $config.ApiPort
    if ($null -ne $owner) {
        Write-ZeroNote "PID        $($owner.ProcessId)"
        Write-ZeroNote "PROCESS    $($owner.ProcessName)"
    }
    Write-ZeroNote 'REASON     foreign process'
    Write-ZeroNote 'ZERO will not stop a process it did not start.'
} elseif (-not (Test-Path -LiteralPath (Join-Path $paths.RuntimeDir 'zero'))) {
    Write-ZeroWarn "not checked out at $($paths.RuntimeDir)"
    Write-ZeroNote "git clone https://github.com/ChrisTheKey/HWD-ZERO `"$($paths.RuntimeDir)`""
} elseif (-not $python) {
    Write-ZeroWarn 'python is missing, so HWD-ZERO cannot be started here'
} else {
    $backendExpected = $true
    Remove-Item -LiteralPath $paths.ZeroLog -Force -ErrorAction SilentlyContinue
    $arguments = @('-m', 'zero.server', '--host', '127.0.0.1', '--port', [string]$config.ApiPort, '--quiet')
    $backendEnvironment = @{
        ZERO_LOG_DIR   = $paths.LogDir
        ZERO_VOICE_LOG = $paths.VoiceLog
    }
    # The runtime finds whisper on its own, but only where it knows to look.
    # Handing it what this script already found removes a whole class of
    # "I built it and ZERO still says it is missing" - which has consistently
    # turned out to be a discovery gap rather than a broken build.
    $foundWhisper = Get-ZeroWhisperBinary
    if ($foundWhisper) { $backendEnvironment['ZERO_WHISPER_BIN'] = $foundWhisper }
    $foundModel = Get-ZeroWhisperModel
    if ($foundModel) { $backendEnvironment['ZERO_WHISPER_MODEL'] = $foundModel }
    Write-ZeroWarn "starting: $python $($arguments -join ' ')"
    $backend = Start-ZeroBackground -FilePath $python -ArgumentList $arguments `
        -WorkingDirectory $paths.RuntimeDir `
        -LogFile $paths.ZeroLog `
        -Environment $backendEnvironment
    if ($backend) {
        Set-Content -LiteralPath $paths.ZeroPid -Value $backend.Id -Encoding ascii
        Write-ZeroOk "hwd-zero started (pid $($backend.Id))"
        $superviseCommand = "$python $($arguments -join ' ')"
    } else {
        Write-ZeroWarn 'could not launch HWD-ZERO'
        $backendExpected = $false
    }
}

# --------------------------------------------------------------------------
Write-ZeroStep '7 - BACKEND HEALTH'
$attempts = 1
if ($backendExpected) { $attempts = 30 }
$zeroState = $null
for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
    $zeroState = Get-ZeroHealthField -Url $config.HealthUrl -Field 'zero'
    if ($zeroState -eq 'healthy') { break }
    if ($attempts -gt 1) { Start-Sleep -Milliseconds 500 }
}
$gatewayState = Get-ZeroHealthField -Url $config.HealthUrl -Field 'gateway'
if ($gatewayState -eq 'healthy') { Write-ZeroOk 'gateway    healthy' } else { Write-ZeroBad "gateway    $gatewayState" }
if ($zeroState -eq 'healthy') {
    Write-ZeroOk 'hwd-zero   healthy'
} else {
    Write-ZeroWarn 'hwd-zero   offline - the interface stays up and reports BACKEND OFFLINE'
    Get-ZeroLogTail -Path $paths.ZeroLog -Lines 40 | ForEach-Object { Write-ZeroNote $_ }
    Get-ZeroLogTail -Path $paths.VoiceLog -Lines 20 | ForEach-Object { Write-ZeroNote $_ }
}

# --------------------------------------------------------------------------
Write-ZeroStep '8 - SUPERVISOR'
if ($NoSupervise) {
    Write-ZeroOk 'skipped (-NoSupervise)'
} elseif (-not $backendExpected -or -not $superviseCommand) {
    # A supervisor for a backend that never came up would log the same failure
    # every ten seconds and fix nothing.
    Write-ZeroWarn 'not started - there is no backend to supervise'
} elseif ($null -ne (Get-ZeroLivePid -Path $paths.SupervisorPid)) {
    Write-ZeroOk 'supervisor is already running'
} else {
    $shell = (Get-Process -Id $PID).Path
    if (-not $shell) { $shell = 'powershell.exe' }
    # The command goes in a file, not on the command line: it contains spaces
    # and, on Windows, paths with spaces in them.
    if ($superviseCommand) {
        Set-Content -LiteralPath (Join-Path $paths.RunDir 'supervise.cmd') -Value $superviseCommand -Encoding ascii
    }
    $superviseArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $PSScriptRoot 'zero-windows-supervise.ps1')
    )
    $supervisor = Start-ZeroBackground -FilePath $shell -ArgumentList $superviseArgs `
        -WorkingDirectory $paths.Root -LogFile (Join-Path $paths.LogDir 'supervisor.out.log')
    # The supervisor writes its own pid file, and it is the only writer. With
    # two writers, a supervisor that died on startup had its pid file removed
    # by its own cleanup and then recreated here — leaving a stale file that
    # looked like a running supervisor.
    $running = $null
    if ($supervisor) {
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $running = Get-ZeroLivePid -Path $paths.SupervisorPid
            if ($null -ne $running) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -ne $running) {
        Write-ZeroOk "supervisor running (pid $running) - restarts HWD-ZERO if it dies"
    } else {
        Write-ZeroWarn 'supervisor did not start; HWD-ZERO will not be restarted automatically'
        Get-ZeroLogTail -Path (Join-Path $paths.LogDir 'supervisor.out.log') -Lines 15 |
            ForEach-Object { Write-ZeroNote $_ }
    }
}

# --------------------------------------------------------------------------
Write-ZeroReadyBlock -Summary (Get-ZeroRuntimeSummary -Config $config -Paths $paths)
Write-Host ''
Write-Host "STOP     powershell -NoProfile -File `"$(Join-Path $PSScriptRoot 'zero-windows-stop.ps1')`""
Write-Host "STATUS   powershell -NoProfile -File `"$(Join-Path $PSScriptRoot 'zero-windows-status.ps1')`""
Write-Host "DOCTOR   powershell -NoProfile -File `"$(Join-Path $PSScriptRoot 'zero-windows-doctor.ps1')`""
Write-Host ''
exit 0
