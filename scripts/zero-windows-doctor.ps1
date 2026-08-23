<#
.SYNOPSIS
    What is actually wrong, in one screen - and a remedy for each line.

.DESCRIPTION
    Every check prints PASS, WARN or FAIL and, when it is not PASS, the exact
    command that fixes it. Nothing here starts, stops, installs or repairs
    anything: a diagnostic that changes the system cannot be run while
    diagnosing one.

    WARN means degraded but usable - no whisper model means voice is off and
    ZERO still runs. FAIL means the interface will not come up. The exit code
    is non-zero only for FAIL, so this is safe to call from another script.

    Prints no token, no cookie and no secret.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'lib-zero.ps1')
$ErrorActionPreference = 'Continue'

$script:Failures = 0
$script:Warnings = 0
function Pass { param([string]$Text) Write-Host "  PASS  $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "  WARN  $Text" -ForegroundColor Yellow; $script:Warnings++ }
function Fail { param([string]$Text) Write-Host "  FAIL  $Text" -ForegroundColor Red; $script:Failures++ }
function Info { param([string]$Text) Write-Host "  INFO  $Text" -ForegroundColor Cyan }
function Hint { param([string]$Text) Write-Host "        $Text" -ForegroundColor DarkGray }
function Group { param([string]$Text) Write-Host ''; Write-Host $Text -ForegroundColor White }

$paths = Get-ZeroPaths
$config = Get-ZeroConfig -Root $paths.Root

Write-Host ''
Write-Host "ZERO DOCTOR (windows)  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "  root       $($paths.Root)"
Write-Host "  workspace  $($paths.Workspace)"
Write-Host "  runtime    $($paths.RuntimeDir)"

# ------------------------------------------------------------------ platform
Group 'PLATFORM'
if (Test-ZeroIsWindows) {
    $caption = 'Windows'
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $caption = "$($os.Caption) build $($os.BuildNumber)"
    } catch { }
    Pass "windows    $caption"
} else {
    # The scripts are written for Windows; running them elsewhere is a
    # deliberate act (usually a test), and saying so beats pretending.
    Info "platform   not Windows - these scripts target Windows 11"
}
$psVersion = $PSVersionTable.PSVersion
if ($psVersion.Major -ge 5) {
    Pass "powershell $psVersion ($($PSVersionTable.PSEdition))"
} else {
    Fail "powershell $psVersion is too old - 5.1 is the floor"
    Hint 'Windows 11 ships with 5.1; install PowerShell 7 with: winget install --id Microsoft.PowerShell'
}

# ----------------------------------------------------------------- toolchain
Group 'TOOLCHAIN'
foreach ($tool in @(
        @{ Name = 'git'; Command = 'git'; Args = @('--version'); Required = $true; Winget = 'Git.Git' },
        @{ Name = 'node'; Command = 'node'; Args = @('-v'); Required = $true; Winget = 'OpenJS.NodeJS.LTS' },
        @{ Name = 'npm'; Command = 'npm'; Args = @('-v'); Required = $true; Winget = 'OpenJS.NodeJS.LTS' },
        @{ Name = 'cmake'; Command = 'cmake'; Args = @('--version'); Required = $false; Winget = 'Kitware.CMake' }
    )) {
    $found = Get-Command $tool.Command -ErrorAction SilentlyContinue
    if ($found) {
        $version = ''
        try { $version = (& $tool.Command @($tool.Args) 2>&1 | Select-Object -First 1) } catch { $version = '' }
        Pass ('{0,-10} {1}' -f $tool.Name, $version)
    } elseif ($tool.Required) {
        Fail "$($tool.Name) is missing"
        Hint "winget install --id $($tool.Winget) --scope user"
    } else {
        # CMake is only needed to *build* whisper. A prebuilt one is fine.
        Warn "$($tool.Name) is missing - whisper.cpp cannot be built here"
        Hint "winget install --id $($tool.Winget)"
    }
}

$python = $null
foreach ($candidate in @((Join-Path $paths.RuntimeDir '.venv\Scripts\python.exe'), 'py', 'python', 'python3')) {
    if ($candidate -like '*\*') {
        if (Test-Path -LiteralPath $candidate) { $python = $candidate; break }
    } elseif (Get-Command $candidate -ErrorAction SilentlyContinue) { $python = $candidate; break }
}
if ($python) {
    Pass ('{0,-10} {1} ({2})' -f 'python', (& $python --version 2>&1), $python)
    $pipOk = $false
    try { & $python -m pip --version *> $null; $pipOk = ($LASTEXITCODE -eq 0) } catch { $pipOk = $false }
    if ($pipOk) { Pass 'pip        available' } else { Fail 'pip is not available for that interpreter'; Hint "$python -m ensurepip --upgrade" }
} else {
    Fail 'python is missing - HWD-ZERO cannot run'
    Hint 'winget install --id Python.Python.3.12 --scope user'
}

# ---------------------------------------------------------------- checkouts
Group 'REPOSITORIES'
foreach ($repo in @(
        @{ Name = 'brain-interface'; Path = $paths.Root; Marker = 'package.json' },
        @{ Name = 'HWD-ZERO'; Path = $paths.RuntimeDir; Marker = 'zero' }
    )) {
    if (Test-Path -LiteralPath (Join-Path $repo.Path $repo.Marker)) {
        Pass ('{0,-16} {1}' -f $repo.Name, $repo.Path)
        if (Get-Command git -ErrorAction SilentlyContinue) {
            $branch = (& git -C $repo.Path rev-parse --abbrev-ref HEAD 2>$null)
            $commit = (& git -C $repo.Path rev-parse --short HEAD 2>$null)
            if ($branch) { Pass ('{0,-16} branch {1} at {2}' -f '', $branch, $commit) }
            $dirty = (& git -C $repo.Path status --porcelain 2>$null)
            if ($dirty) {
                # Never a FAIL: local work is the operator's, and the one-shot
                # is built around never discarding it.
                Warn ('{0,-16} has uncommitted changes - the one-shot will not discard them' -f '')
            }
        }
    } else {
        Fail "$($repo.Name) is not checked out at $($repo.Path)"
        Hint "git clone https://github.com/ChrisTheKey/$($repo.Name) `"$($repo.Path)`""
    }
}
if ($python -and (Test-Path -LiteralPath (Join-Path $paths.RuntimeDir 'zero'))) {
    Push-Location -LiteralPath $paths.RuntimeDir
    & $python -c 'import zero.server' *> $null
    $importable = ($LASTEXITCODE -eq 0)
    Pop-Location
    if ($importable) { Pass 'zero.server is importable' }
    else { Fail 'zero.server cannot be imported'; Hint "cd `"$($paths.RuntimeDir)`"; $python -m pip install -e ." }
}
if (Test-Path -LiteralPath (Join-Path $paths.Root 'node_modules')) {
    Pass 'node_modules is installed'
} else {
    Warn 'node_modules is missing - the interface cannot be built'
    Hint "cd `"$($paths.Root)`"; npm install"
}

# --------------------------------------------------------------------- ports
Group 'PORTS'
foreach ($entry in @(
        @{ Name = 'interface'; Port = $config.UiPort; PidFile = $paths.GatewayPid },
        @{ Name = 'hwd-zero'; Port = $config.ApiPort; PidFile = $paths.ZeroPid }
    )) {
    if (-not (Test-ZeroPortBusy -Port $entry.Port)) {
        Pass "$($entry.Name) port $($entry.Port) is free"
        continue
    }
    $owner = Get-ZeroPortOwner -Port $entry.Port
    $recorded = Get-ZeroLivePid -Path $entry.PidFile
    $zero = Get-ZeroServiceOnPort -Port $entry.Port
    if ($null -ne $zero) {
        Pass "$($entry.Name) port $($entry.Port) - HWD-ZERO (pid $($zero.ProcessId), version $($zero.Version))"
    } elseif ($null -ne $owner -and $null -ne $recorded -and $owner.ProcessId -eq $recorded) {
        Pass "$($entry.Name) port $($entry.Port) - ours (pid $($owner.ProcessId), $($owner.ProcessName))"
    } elseif ($null -ne $owner) {
        Warn "$($entry.Name) port $($entry.Port) is held by $($owner.ProcessName) (pid $($owner.ProcessId)) - foreign process"
        Hint 'ZERO will not stop a process it did not start. Free it, or set ZERO_UI_PORT / ZERO_API_URL.'
    } elseif ($null -ne $recorded -and (Test-ZeroHttp -Url "http://127.0.0.1:$($entry.Port)/api/health")) {
        # The owning pid could not be read — no NetTCPIP module, no netstat —
        # but our own pid file names a live process and the port answers our
        # health endpoint. That is evidence enough to stop warning about it.
        Pass "$($entry.Name) port $($entry.Port) - ours (pid $recorded, by pid file and health)"
    } else {
        Warn "$($entry.Name) port $($entry.Port) is busy and this shell cannot see the owner"
        Hint "Get-NetTCPConnection -LocalPort $($entry.Port)"
    }
}

# ----------------------------------------------------------------- run state
Group 'RUN STATE'
foreach ($entry in @(
        @{ Name = 'gateway'; Path = $paths.GatewayPid },
        @{ Name = 'hwd-zero'; Path = $paths.ZeroPid },
        @{ Name = 'supervisor'; Path = $paths.SupervisorPid }
    )) {
    $processId = Get-ZeroLivePid -Path $entry.Path
    if ($null -ne $processId) {
        Pass "$($entry.Name) running (pid $processId)"
    } elseif (Test-Path -LiteralPath $entry.Path) {
        Warn "$($entry.Name) pid file is stale - the process is gone"
        Hint '.\scripts\zero-windows-stop.ps1'
    } else {
        Warn "$($entry.Name) is not running"
    }
}

# ------------------------------------------------------------------- serving
Group 'SERVING'
if (Test-ZeroHttp -Url $config.HealthUrl) {
    Pass "gateway answers $($config.HealthUrl)"
    $gatewayState = Get-ZeroHealthField -Url $config.HealthUrl -Field 'gateway'
    $zeroState = Get-ZeroHealthField -Url $config.HealthUrl -Field 'zero'
    if ($gatewayState -eq 'healthy') { Pass 'gateway    healthy' } else { Warn "gateway    $gatewayState" }
    if ($zeroState -eq 'healthy') { Pass 'hwd-zero   healthy' }
    else { Warn 'hwd-zero   offline - the interface stays up and reports BACKEND OFFLINE' }
} else {
    Fail "nothing is serving http://127.0.0.1:$($config.UiPort)"
    Hint '.\scripts\zero-windows-start.ps1'
}

$identity = Get-ZeroServiceOnPort -Port $config.ApiPort
if ($null -ne $identity) {
    Pass "HWD-ZERO identifies itself: pid $($identity.ProcessId), version $($identity.Version), started $($identity.StartedAt)"
    if ($identity.Ready) { Pass 'ZeroSession runtime is ready' } else { Warn 'ZeroSession runtime is not ready yet' }
} else {
    Warn "HWD-ZERO is not answering on $($config.ApiUrl)"
    Hint "see $($paths.ZeroLog)"
}

$stream = Test-ZeroEventStream -UiPort $config.UiPort -TimeoutSec 6
switch ($stream.Level) {
    'full' { Pass "event stream FULL - $($stream.Detail)" }
    'partial' { Warn "event stream PARTIAL - $($stream.Detail)" }
    'unknown' { Info "event stream could not be tested - $($stream.Detail)" }
    default { Warn "event stream OFFLINE - $($stream.Detail)" }
}

# --------------------------------------------------------------------- voice
Group 'VOICE'
$whisper = Get-ZeroWhisperBinary
if ($whisper) {
    $probe = Test-ZeroWhisperBinary -Path $whisper
    if ($probe.Ok) {
        Pass "whisper.cpp runs: $whisper"
    } else {
        # Present is not the same as working: a build for the wrong
        # architecture passes every Test-Path and fails when audio arrives.
        Fail "whisper.cpp is present but does not run: $whisper"
        Hint "$($probe.Detail)"
        Hint 'cmake -B build; cmake --build build --config Release -j 2   (in %USERPROFILE%\whisper.cpp)'
    }
} else {
    Warn 'no whisper.cpp binary found - voice input is unavailable'
    Hint '.\scripts\zero-windows-one-shot.ps1   (builds it with -j 2)'
}

$model = Get-ZeroWhisperModel
if ($model) {
    $check = Test-ZeroWhisperModel -Path $model
    if ($check.Ok) {
        Pass "whisper model: $model ($($check.SizeMb) MB)"
    } else {
        Fail "whisper model is not usable ($($check.Reason), $($check.SizeMb) MB)"
        Hint "Remove-Item `"$model`"; then re-run the one-shot"
    }
} else {
    Warn 'no whisper model found - voice input is unavailable'
    Hint '.\scripts\zero-windows-one-shot.ps1   (downloads ggml-tiny.bin, ~75 MB)'
}

$voiceResult = Invoke-ZeroHttp -Url "http://127.0.0.1:$($config.UiPort)/api/voice/status"
if ($voiceResult.Answered -and $voiceResult.Body) {
    try {
        $payload = $voiceResult.Body | ConvertFrom-Json
        if ($payload.voice -eq 'ready') { Pass 'voice is ready end to end' }
        else { Warn "voice is $($payload.voice) - ZERO runs, speech input does not" }
        if ($payload.stt) {
            if ($payload.stt.ready -eq $true) { Pass "stt provider: $($payload.stt.provider)" }
            else { Warn "stt: $($payload.stt.reason) - $($payload.stt.detail)"; if ($payload.stt.remedy) { Hint $payload.stt.remedy } }
        }
        if ($payload.reasoning) { Pass "reasoning provider: $($payload.reasoning.provider)" }
    } catch {
        Warn 'the voice endpoint answered with something unreadable'
    }
} else {
    Warn 'the voice endpoint did not answer (is HWD-ZERO up?)'
}

# The one thing PowerShell genuinely cannot answer.
Info 'browser microphone support cannot be tested from PowerShell'
Hint "open $($config.InterfaceUrl) in Chrome or Edge and allow the microphone once"

# --------------------------------------------------------------------- agents
Group 'AGENTS'
$agentResult = Invoke-ZeroHttp -Url "http://127.0.0.1:$($config.UiPort)/api/agents/children"
if ($agentResult.Answered -and $agentResult.Body) {
    try {
        $payload = $agentResult.Body | ConvertFrom-Json
        $count = @($payload.repositories).Count
        if ($count -gt 0) { Pass "$count child agent repositories discovered under $($payload.root)" }
        else { Warn "no child agent repositories found under $($payload.root)" }
        if (@($payload.excluded).Count -gt 0) {
            Info "excluded by policy: $((@($payload.excluded)) -join ', ')"
        }
    } catch { Warn 'the agent endpoint answered with something unreadable' }
} else {
    Warn 'the agent endpoint did not answer (is HWD-ZERO up?)'
}

# ------------------------------------------------------------------ voice out
Group 'VOICE OUT (TTS)'
# The key itself is never printed, echoed or length-reported. Only whether it
# is there.
$localOnly = @('1', 'true', 'yes', 'on') -contains ("$($env:ZERO_LOCAL_ONLY)".ToLower())
$fishOn = @('1', 'true', 'yes', 'on') -contains ("$($env:FISH_AUDIO_ENABLED)".ToLower())
if ($localOnly) {
    Pass 'LOCAL-ONLY is ON - no cloud voice is called, whatever else is set'
} elseif (-not $fishOn) {
    Warn 'Fish Audio is NOT CONFIGURED - ZERO speaks with the browser voice'
    Hint 'set FISH_AUDIO_ENABLED=true and FISH_API_KEY in .env.local'
} else {
    Pass 'Fish Audio is CONFIGURED'
    if ($env:FISH_API_KEY) {
        Pass 'API key PRESENT'
    } else {
        Fail 'API key MISSING'
        Hint 'Fish Audio requires a Fish API key. Put FISH_API_KEY in .env.local (git-ignored).'
    }
    $model = $env:FISH_AUDIO_MODEL
    if (-not $model) { $model = 's2.1-pro-free' }
    if ($model -eq 's2.1-pro-free') {
        Pass "free model $model selected"
    } else {
        # Nothing upgrades on its own; reaching a paid model takes writing one
        # down, and the operator should know they did.
        Warn "model $model is not the free tier - this one bills"
    }
    if ($env:FISH_AUDIO_VOICE_ID) {
        $voiceName = $env:FISH_AUDIO_VOICE_NAME
        if (-not $voiceName) { $voiceName = $env:FISH_AUDIO_VOICE_ID }
        Pass "voice $voiceName"
    } else {
        Fail 'no voice configured'
        Hint 'set FISH_AUDIO_VOICE_ID - see .env.example for two public ones'
    }
}
$ttsReady = Get-ZeroHealthField -Url "http://127.0.0.1:$($config.UiPort)/api/voice/tts/status" -Field 'ready'
if ($ttsReady -eq $true) {
    Pass 'TTS READY - cloud (text is sent to Fish Audio)'
} elseif ($ttsReady -eq $false) {
    Warn 'TTS DEGRADED - the browser voice speaks instead'
} else {
    Warn 'the gateway did not answer /api/voice/tts/status'
}

# ------------------------------------------------------------------ resources
Group 'METRICOOL MCP'
$metricoolUrl = "http://127.0.0.1:$($config.UiPort)/api/integrations/metricool/status"
$metricoolResult = Invoke-ZeroHttp -Url $metricoolUrl
if (-not $metricoolResult.Answered) {
    Warn "the runtime did not answer $metricoolUrl"
    Hint 'start ZERO first; this reads the live integration, not a config file'
} else {
    try {
        $metricool = $metricoolResult.Body | ConvertFrom-Json
        if ($metricool.blocked_by -eq 'local_only') {
            # Not a failure. It is the operator's own setting doing what it says.
            Pass 'LOCAL ONLY is ON - Metricool is BLOCKED and no socket is opened'
        } elseif ($metricool.blocked_by -eq 'metricool_disabled') {
            Warn 'DISCONNECTED - the integration is switched off (ZERO_METRICOOL_ENABLED)'
        } elseif ($metricool.connected -eq $true) {
            Pass "CONNECTED - $($metricool.server)"
            $brands = [int]$metricool.brands
            if ($brands -gt 0) {
                Pass "BRANDS $brands"
            } else {
                Warn 'BRANDS 0 - this account has no brands, so there is nothing to publish to'
            }
            $networks = @($metricool.networks)
            if ($networks.Count -gt 0) {
                Pass "CONNECTED NETWORKS $($networks.Count): $($networks -join ', ')"
            } else {
                Warn 'CONNECTED NETWORKS none - no social account is linked to the brand'
            }
            if ($metricool.publishing_ready -eq $true) {
                Pass 'PUBLISHING READY - every post still stops at an approval'
            } else {
                Warn "PUBLISHING BLOCKED - $($metricool.reason)"
            }
            $missing = @($metricool.capabilities.missing)
            if ($missing.Count -gt 0) {
                Info "capabilities this server does not publish: $($missing -join ', ')"
            }
        } else {
            Warn 'AUTH REQUIRED - nobody has signed in to Metricool yet'
            Hint 'open the interface and press CONNECT METRICOOL; no token goes in a file by hand'
        }
    } catch {
        Warn "the Metricool status could not be read: $($_.Exception.Message)"
    }
}
if ($env:ZERO_LOCAL_ONLY -eq 'true') {
    Info 'LOCAL ONLY ON'
} else {
    Info 'LOCAL ONLY OFF'
}

Group 'RESOURCES'
foreach ($dir in @($paths.RunDir, $paths.LogDir)) {
    $writable = $false
    try {
        $probe = Join-Path $dir ('.write-test-' + [guid]::NewGuid().ToString('N'))
        Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        $writable = $true
    } catch { $writable = $false }
    if ($writable) { Pass "writable: $dir" } else { Fail "not writable: $dir" }
}
if (Test-Path -LiteralPath $paths.VoiceLog) {
    $lines = @(Get-Content -LiteralPath $paths.VoiceLog -ErrorAction SilentlyContinue).Count
    Pass "voice log: $($paths.VoiceLog) ($lines lines)"
} else {
    Warn 'no voice log yet - nothing has been spoken since the last start'
}
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $totalMb = [int]($os.TotalVisibleMemorySize / 1024)
    $freeMb = [int]($os.FreePhysicalMemory / 1024)
    if ($freeMb -lt 700) {
        Warn "RAM: ${freeMb} MB free of ${totalMb} MB - whisper needs roughly 200 MB for ggml-tiny"
    } else {
        Pass "RAM: ${freeMb} MB free of ${totalMb} MB"
    }
} catch {
    Info 'RAM could not be read on this platform'
}
$root = [System.IO.Path]::GetPathRoot($paths.Root)
$freeGb = -1
if ($root) {
    try {
        $freeGb = [math]::Round(((New-Object System.IO.DriveInfo($root)).AvailableFreeSpace) / 1GB, 1)
    } catch {
        $freeGb = -1
    }
}
if ($freeGb -lt 0) {
    Info 'free disk space could not be read'
} elseif ($freeGb -lt 2) {
    # A whisper.cpp checkout, its build tree and a tiny model come to roughly
    # this much, and a build that runs out of disk fails halfway through.
    Warn "disk: $freeGb GB free on $root - a whisper build and model need roughly 2 GB"
} else {
    Pass "disk: $freeGb GB free on $root"
}

# ------------------------------------------------------------------- verdict
Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) FAIL, $($script:Warnings) WARN - fix the FAILs above, then re-run." -ForegroundColor Red
    exit 1
}
if ($script:Warnings -gt 0) {
    Write-Host "0 FAIL, $($script:Warnings) WARN - ZERO runs; the warnings are degraded capabilities." -ForegroundColor Yellow
    exit 0
}
Write-Host 'all checks pass' -ForegroundColor Green
exit 0
