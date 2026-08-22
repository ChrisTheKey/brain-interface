<#
    Shared helpers for ZERO on Windows.

    The bash side has `lib-zero.sh`; this is its counterpart, and it exists for
    the same reason: every ZERO script needs to answer the same handful of
    awkward questions — where is the workspace, who holds this port, is that
    pid really ours, is whisper actually installed — and each script inventing
    its own answer is how the two halves drift apart.

    Three rules carried over from the phone, because they were learned the hard
    way and Windows does not exempt them:

    **Any HTTP status is an answer.** The gateway replies 503 to /api/health
    precisely when it is healthy and the backend is not. Treating 503 as "dead"
    is what once made a start script kill a working gateway.

    **Identity, not liveness.** A stranger on port 8000 answers TCP exactly as
    convincingly as HWD-ZERO does. Only `service = HWD-ZERO` in the health
    payload proves it is ours, and only then may it be adopted or stopped.

    **Never a global kill.** No `taskkill /F /IM python.exe`, no
    `Stop-Process -Name node`. Every process these scripts stop, these scripts
    started, and it is identified by pid file and verified before it is touched.

    Dot-source it:  . "$PSScriptRoot\lib-zero.ps1"

    Windows PowerShell 5.1 is the floor. No ternaries, no null-coalescing, no
    `-AsHashtable`, no `$IsWindows` without a guard — all of those are 7+, and
    the ThinkPad ships with 5.1.
#>

# --------------------------------------------------------------------- paths

function Get-ZeroRoot {
    <# The brain-interface checkout this library lives in. #>
    return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Test-ZeroIsWindows {
    # `$IsWindows` only exists in PowerShell 6+. In 5.1 it is $null, and 5.1
    # only ever runs on Windows.
    if ($PSVersionTable.PSEdition -eq 'Desktop') { return $true }
    return [bool](Get-Variable -Name IsWindows -ValueOnly -ErrorAction SilentlyContinue)
}

function Get-ZeroWorkspace {
    <#
        The directory holding HWD-ZERO and brain-interface side by side.

        Discovered from where this script actually is rather than assumed, so a
        checkout under Documents, OneDrive or a second drive works without
        configuration — and no username is ever hardcoded.
    #>
    param([string]$Root)
    if ($env:ZERO_WORKSPACE) { return $env:ZERO_WORKSPACE }
    if (-not $Root) { $Root = Get-ZeroRoot }
    return (Split-Path -Parent $Root)
}

function Resolve-ZeroRuntimeDir {
    <# Where HWD-ZERO is checked out. Names differ across machines. #>
    param([string]$Workspace)
    if ($env:ZERO_RUNTIME_DIR) { return $env:ZERO_RUNTIME_DIR }
    if (-not $Workspace) { $Workspace = Get-ZeroWorkspace }
    foreach ($name in @('HWD-ZERO', 'hwd-zero', 'HWD_ZERO', 'hwd_zero', 'HWDZERO')) {
        $candidate = Join-Path $Workspace $name
        if (Test-Path -LiteralPath (Join-Path $candidate 'zero')) { return $candidate }
    }
    # Nothing found: name the canonical location, so the error is actionable.
    return (Join-Path $Workspace 'HWD-ZERO')
}

function Get-ZeroPaths {
    <# Every path the Windows scripts use, resolved once. #>
    param([string]$Root)
    if (-not $Root) { $Root = Get-ZeroRoot }
    $state = Join-Path $Root '.zero'
    $run = Join-Path $state 'run'
    $logs = Join-Path $state 'logs'
    foreach ($dir in @($state, $run, $logs)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
    $workspace = Get-ZeroWorkspace -Root $Root
    return [pscustomobject]@{
        Root          = $Root
        Workspace     = $workspace
        RuntimeDir    = (Resolve-ZeroRuntimeDir -Workspace $workspace)
        StateDir      = $state
        RunDir        = $run
        LogDir        = $logs
        GatewayPid    = (Join-Path $run 'gateway.pid')
        ZeroPid       = (Join-Path $run 'hwd-zero.pid')
        SupervisorPid = (Join-Path $run 'supervisor.pid')
        GatewayLog    = (Join-Path $logs 'gateway.log')
        ZeroLog       = (Join-Path $logs 'hwd-zero.log')
        VoiceLog      = (Join-Path $logs 'voice.log')
        SupervisorLog = (Join-Path $logs 'supervisor.log')
        BuildLog      = (Join-Path $logs 'build.log')
    }
}

function Get-ZeroConfig {
    <#
        Ports and upstreams, with .env.local honoured.

        Loopback by default and deliberately: on Windows, binding 0.0.0.0 is
        what makes Defender ask about a public network, and the interface has
        no reason to be there unless the operator says so.
    #>
    param([string]$Root)
    if (-not $Root) { $Root = Get-ZeroRoot }
    $envFile = Join-Path $Root '.env.local'
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in (Get-Content -LiteralPath $envFile)) {
            # Only plain KEY=value, and only ZERO's own keys. A .env.local is
            # not a script and must never be executed like one.
            if ($line -match '^\s*(ZERO_[A-Z0-9_]+|VITE_ZERO_[A-Z0-9_]+)\s*=\s*(.*)$') {
                $name = $Matches[1]
                $value = $Matches[2].Trim().Trim('"').Trim("'")
                if (-not [Environment]::GetEnvironmentVariable($name)) {
                    Set-Item -Path "env:$name" -Value $value
                }
            }
        }
    }
    $uiPort = 3000
    if ($env:ZERO_UI_PORT) { $uiPort = [int]$env:ZERO_UI_PORT }
    $apiUrl = 'http://127.0.0.1:8000'
    if ($env:ZERO_API_URL) { $apiUrl = $env:ZERO_API_URL }
    # Empty unless the operator set it. The codex app-server is an optional
    # executor, not the runtime — ZeroSession is — so a Windows install that
    # never had one should report "not configured" rather than "offline". The
    # bash side defaults to ws://127.0.0.1:8787 for historical reasons; here
    # there is no history to preserve.
    $runtimeWs = ''
    if ($env:ZERO_RUNTIME_WS_URL) { $runtimeWs = $env:ZERO_RUNTIME_WS_URL }
    return [pscustomobject]@{
        UiPort       = $uiPort
        ApiUrl       = $apiUrl.TrimEnd('/')
        ApiPort      = (Get-ZeroUrlPort -Url $apiUrl)
        RuntimeWsUrl = $runtimeWs
        HealthUrl    = "http://127.0.0.1:$uiPort/api/health"
        InterfaceUrl = "http://localhost:$uiPort"
    }
}

function Get-ZeroUrlPort {
    <# The port of a url, with the scheme's default when none is written. #>
    param([Parameter(Mandatory = $true)][string]$Url)
    try {
        $parsed = [System.Uri]$Url
        if ($parsed.Port -gt 0) { return $parsed.Port }
        if ($parsed.Scheme -eq 'https' -or $parsed.Scheme -eq 'wss') { return 443 }
        return 80
    } catch {
        return 0
    }
}

# ---------------------------------------------------------------------- http

function Invoke-ZeroHttp {
    <#
        One GET, and *any* HTTP status counts as an answer.

        503 from the gateway means "I am fine, the backend is not" — the single
        most important status this whole system reports. A helper that treats
        it as failure turns a healthy gateway into one a script kills.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSec = 3
    )
    $empty = [pscustomobject]@{ Answered = $false; Status = 0; Body = '' }
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return [pscustomobject]@{
            Answered = $true
            Status   = [int]$response.StatusCode
            Body     = [string]$response.Content
        }
    } catch {
        # 5.1 raises WebException with a readable stream; 7+ raises
        # HttpResponseException and puts the body in ErrorDetails. Both are an
        # answer, and both are handled rather than reported as "down".
        $exception = $_.Exception
        $response = $null
        try { $response = $exception.Response } catch { $response = $null }
        if ($null -ne $response) {
            $status = 0
            try { $status = [int]$response.StatusCode } catch { $status = 0 }
            $body = ''
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $body = [string]$_.ErrorDetails.Message
            } else {
                try {
                    $stream = $response.GetResponseStream()
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                    $reader.Close()
                } catch { $body = '' }
            }
            if ($status -gt 0) {
                return [pscustomobject]@{ Answered = $true; Status = $status; Body = $body }
            }
        }
        return $empty
    }
}

function Test-ZeroHttp {
    <# Did anything answer at all? Status is deliberately not consulted. #>
    param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutSec = 3)
    return (Invoke-ZeroHttp -Url $Url -TimeoutSec $TimeoutSec).Answered
}

function Get-ZeroHealthField {
    <# One field out of a health payload. Nothing on failure, never a guess. #>
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Field,
        [int]$TimeoutSec = 3
    )
    $result = Invoke-ZeroHttp -Url $Url -TimeoutSec $TimeoutSec
    if (-not $result.Answered -or -not $result.Body) { return $null }
    try {
        $payload = $result.Body | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($null -eq $payload) { return $null }
    if ($payload.PSObject.Properties.Name -contains $Field) {
        return $payload.$Field
    }
    return $null
}

function Wait-ZeroHttp {
    <# Poll until something answers, or give up. #>
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSec = 20,
        [double]$IntervalSec = 0.5
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-ZeroHttp -Url $Url -TimeoutSec 2) { return $true }
        Start-Sleep -Milliseconds ([int]($IntervalSec * 1000))
    }
    return $false
}

# --------------------------------------------------------------------- ports

function Test-ZeroPortBusy {
    <# Is anything accepting connections here? A plain TCP dial, no tooling. #>
    param([Parameter(Mandatory = $true)][int]$Port, [string]$ComputerName = '127.0.0.1')
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        $ready = $async.AsyncWaitHandle.WaitOne(1500, $false)
        if ($ready -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

function ConvertFrom-ZeroNetstat {
    <#
        The listening pid for a port, out of `netstat -ano` output.

        Separate from the caller so it can be tested against real netstat text
        rather than against whatever this machine happens to be running.
        `Get-NetTCPConnection` is preferred and this is the fallback: it exists
        on every Windows there is, including one with the NetTCPIP module
        unavailable or blocked by policy.
    #>
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Lines,
        [Parameter(Mandatory = $true)][int]$Port
    )
    $found = @()
    foreach ($line in $Lines) {
        $fields = ($line -split '\s+') | Where-Object { $_ -ne '' }
        if ($fields.Count -lt 4) { continue }
        if ($fields[0] -notmatch '^TCP$') { continue }
        if ($fields[-2] -ne 'LISTENING') { continue }
        $local = $fields[1]
        # `127.0.0.1:8000` and `[::1]:8000` both end in `:port`.
        if ($local -notmatch (':' + [regex]::Escape([string]$Port) + '$')) { continue }
        $owner = $fields[-1]
        if ($owner -match '^\d+$' -and [int]$owner -gt 0) { $found += [int]$owner }
    }
    return ($found | Select-Object -Unique)
}

function Get-ZeroPortOwner {
    <#
        Who is listening on this port: pid, process name, and how we know.

        `Get-NetTCPConnection` first because it is structured and exact;
        `netstat -ano` after, because a locked-down machine may not have the
        NetTCPIP module. Prints nothing rather than guessing.
    #>
    param([Parameter(Mandatory = $true)][int]$Port)
    $pids = @()
    $source = ''
    if (Get-Command -Name Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        try {
            $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
            $pids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
            $source = 'Get-NetTCPConnection'
        } catch {
            $pids = @()
        }
    }
    if ($pids.Count -eq 0 -and (Get-Command -Name netstat -ErrorAction SilentlyContinue)) {
        try {
            $lines = @(& netstat -ano 2>$null)
            $pids = @(ConvertFrom-ZeroNetstat -Lines $lines -Port $Port)
            if ($pids.Count -gt 0) { $source = 'netstat -ano' }
        } catch {
            $pids = @()
        }
    }
    if ($pids.Count -eq 0) { return $null }
    $owner = $pids[0]
    $name = ''
    try {
        $process = Get-Process -Id $owner -ErrorAction Stop
        $name = $process.ProcessName
    } catch {
        $name = 'unknown'
    }
    return [pscustomobject]@{
        Port        = $Port
        ProcessId   = $owner
        ProcessName = $name
        AllPids     = $pids
        Source      = $source
    }
}

function Get-ZeroServiceOnPort {
    <#
        Is an HWD-ZERO serving here? Returns its identity, or nothing.

        This is the single-instance check, and it asks rather than assumes.
        Starting a second server against a bound port is what produced
        `[Errno 98] Address already in use` on the phone, and the crash that
        followed it.
    #>
    param([Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutSec = 3)
    $result = Invoke-ZeroHttp -Url "http://127.0.0.1:$Port/api/health" -TimeoutSec $TimeoutSec
    if (-not $result.Answered -or -not $result.Body) { return $null }
    try {
        $payload = $result.Body | ConvertFrom-Json
    } catch {
        return $null
    }
    if ($null -eq $payload -or $payload.service -ne 'HWD-ZERO') { return $null }
    return [pscustomobject]@{
        Service   = [string]$payload.service
        Runtime   = [string]$payload.runtime
        Version   = [string]$payload.version
        ProcessId = [int]$payload.pid
        StartedAt = [string]$payload.started_at
        Ready     = [bool]$payload.runtime_ready
    }
}

function Get-ZeroPortOccupantText {
    <# What holds this port, in a sentence fit for a log line. #>
    param([Parameter(Mandatory = $true)][int]$Port)
    $zero = Get-ZeroServiceOnPort -Port $Port
    if ($null -ne $zero) {
        return "HWD-ZERO (pid $($zero.ProcessId), version $($zero.Version))"
    }
    $owner = Get-ZeroPortOwner -Port $Port
    if ($null -ne $owner) {
        return "$($owner.ProcessName) (pid $($owner.ProcessId)) — foreign process"
    }
    if (Test-ZeroPortBusy -Port $Port) {
        return 'something this shell cannot identify'
    }
    return ''
}

# ---------------------------------------------------------------------- pids

function Get-ZeroLivePid {
    <# The pid in this file, if the file exists and that process is alive. #>
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = ''
    try { $raw = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim() } catch { return $null }
    if ($raw -notmatch '^\d+$') { return $null }
    $candidate = [int]$raw
    if ($candidate -le 0) { return $null }
    try {
        Get-Process -Id $candidate -ErrorAction Stop | Out-Null
        return $candidate
    } catch {
        return $null
    }
}

function Test-ZeroOwnedProcess {
    <#
        Is this pid really one of ours?

        A pid file is not proof. Windows recycles pids, and the process wearing
        one now may be something the operator cares about — so before anything
        is stopped, the process is asked what it is.

        Two levels of evidence, because only one of them is always available:

        1. The command line, read through CIM. `gateway.mjs` or `zero.server`
           in it is conclusive.
        2. When the command line cannot be read — a locked-down machine, a
           process owned by another account, a platform without CIM — the
           executable name. `node` for the gateway, `python` for HWD-ZERO.
           Weaker, but combined with our own pid file it is enough, and the
           alternative is a ZERO that can never stop itself.

        Anything whose name is not even in the right family is refused. A pid
        recycled onto `chrome` or `explorer` is left alone.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [ValidateSet('gateway', 'hwd-zero', 'supervisor', 'any')][string]$Kind = 'any'
    )
    # Pid 0 is the kernel on both platforms and has no name to read. It also
    # happens to be what an unbound `$null` coerces to, which is exactly when
    # this must not go looking for a process to stop.
    if ($ProcessId -le 0) { return $false }
    $process = $null
    try { $process = Get-Process -Id $ProcessId -ErrorAction Stop } catch { return $false }
    $name = ''
    if ($process -and $process.ProcessName) { $name = $process.ProcessName.ToLower() }

    $commandLine = ''
    if (Get-Command -Name Get-CimInstance -ErrorAction SilentlyContinue) {
        try {
            $info = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
            if ($info) { $commandLine = [string]$info.CommandLine }
        } catch {
            $commandLine = ''
        }
    }

    $markers = @{
        'gateway'    = @('gateway.mjs')
        'hwd-zero'   = @('zero.server', 'zero-server')
        'supervisor' = @('zero-windows-supervise')
    }
    $executables = @{
        'gateway'    = @('node')
        'hwd-zero'   = @('python', 'python3', 'py', 'pythonw')
        'supervisor' = @('powershell', 'pwsh')
    }
    $kinds = @($Kind)
    if ($Kind -eq 'any') { $kinds = @('gateway', 'hwd-zero', 'supervisor') }

    if ($commandLine) {
        $haystack = $commandLine.ToLower()
        foreach ($one in $kinds) {
            foreach ($marker in $markers[$one]) {
                if ($haystack -like "*$marker*") { return $true }
            }
        }
        # The command line was readable and says this is something else.
        return $false
    }

    foreach ($one in $kinds) {
        foreach ($executable in $executables[$one]) {
            if ($name -eq $executable) { return $true }
        }
    }
    return $false
}

function Clear-ZeroStalePid {
    <#
        Remove a pid file whose process is gone.

        A stale file must never be mistaken for a running service, and must
        never cause a kill of whatever recycled that pid in the meantime.
    #>
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ($null -ne (Get-ZeroLivePid -Path $Path)) { return $false }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $true
}

function Stop-ZeroTracked {
    <#
        Stop one process this deployment started, and nothing else.

        Graceful first: CloseMainWindow is meaningless for a hidden console
        process, so the honest sequence on Windows is a polite Stop-Process,
        a wait, and only then a forced one — and only for a process that has
        already proved it is ours.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateSet('gateway', 'hwd-zero', 'supervisor', 'any')][string]$Kind = 'any',
        [int]$GraceSeconds = 5
    )
    $target = Get-ZeroLivePid -Path $PidFile
    if ($null -eq $target) {
        $existed = Test-Path -LiteralPath $PidFile
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        if ($existed) {
            return [pscustomobject]@{ Stopped = $false; Reason = 'stale'; ProcessId = 0; Name = $Name }
        }
        return [pscustomobject]@{ Stopped = $false; Reason = 'not_running'; ProcessId = 0; Name = $Name }
    }
    if (-not (Test-ZeroOwnedProcess -ProcessId $target -Kind $Kind)) {
        # The pid was recycled. Whatever is wearing it now is not ours to kill.
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Stopped = $false; Reason = 'foreign'; ProcessId = $target; Name = $Name }
    }
    try { Stop-Process -Id $target -ErrorAction Stop } catch { }
    $deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq (Get-ZeroLivePid -Path $PidFile)) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($null -ne (Get-ZeroLivePid -Path $PidFile)) {
        # Only now, and only for a process already proved ours.
        try { Stop-Process -Id $target -Force -ErrorAction Stop } catch { }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Stopped = $true; Reason = 'stopped'; ProcessId = $target; Name = $Name }
}

# ------------------------------------------------------------------ processes

function ConvertTo-ZeroArgumentList {
    <#
        Quote the arguments that need quoting, and only those.

        `Start-Process -ArgumentList` joins an array with spaces and quotes
        nothing, so one argument containing a space silently becomes several.
        That is not a theoretical hazard: it is how the supervisor was handed
        `python` as its entire start command and the rest of the line vanished
        without an error. Windows paths have spaces in them constantly —
        `C:\Program Files`, `C:\Users\First Last` — so this is the normal case.
    #>
    param([AllowEmptyCollection()][string[]]$ArgumentList = @())
    $quoted = @()
    foreach ($argument in $ArgumentList) {
        if ($null -eq $argument) { continue }
        if ($argument -eq '' -or $argument -match '\s' -or $argument -match '"') {
            # Escape any embedded quote, then wrap the whole thing.
            $quoted += ('"' + ($argument -replace '"', '\"') + '"')
        } else {
            $quoted += $argument
        }
    }
    return $quoted
}

function Start-ZeroBackground {
    <#
        Start one long-lived process, hidden, with its output on disk.

        `Start-Process -PassThru` returns the real child, so the pid file names
        the server rather than a shell that launched it. That distinction is
        not academic: with a wrapper pid recorded, stopping ZERO left the
        actual process running and untracked.

        stdout and stderr go to separate files because Windows cannot redirect
        both to one — `<name>.log` and `<name>.err.log`, and every tail here
        reads both.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$LogFile,
        [hashtable]$Environment = @{}
    )
    foreach ($key in $Environment.Keys) {
        Set-Item -Path "env:$key" -Value ([string]$Environment[$key])
    }
    $errorLog = [System.IO.Path]::ChangeExtension($LogFile, '.err.log')
    foreach ($file in @($LogFile, $errorLog)) {
        $parent = Split-Path -Parent $file
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
    }
    $arguments = @{
        FilePath               = $FilePath
        WorkingDirectory       = $WorkingDirectory
        RedirectStandardOutput = $LogFile
        RedirectStandardError  = $errorLog
        PassThru               = $true
    }
    # `-WindowStyle` is the whole point on Windows — without it every ZERO
    # process flashes up a console window — and it is rejected outright by
    # PowerShell on Linux and macOS, where the tests for this run.
    if (Test-ZeroIsWindows) { $arguments['WindowStyle'] = 'Hidden' }
    if ($ArgumentList.Count -gt 0) {
        $arguments['ArgumentList'] = ConvertTo-ZeroArgumentList -ArgumentList $ArgumentList
    }
    return (Start-Process @arguments)
}

function Get-ZeroLogTail {
    <# The last lines of a log and its error stream, for when something failed. #>
    param([Parameter(Mandatory = $true)][string]$Path, [int]$Lines = 30)
    $output = @()
    foreach ($file in @($Path, [System.IO.Path]::ChangeExtension($Path, '.err.log'))) {
        if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 0) {
            $output += "--- $(Split-Path -Leaf $file) (last $Lines lines) ---"
            $output += (Get-Content -LiteralPath $file -Tail $Lines -ErrorAction SilentlyContinue)
        }
    }
    if ($output.Count -eq 0) { return @("(no output in $(Split-Path -Leaf $Path))") }
    return $output
}

# ------------------------------------------------------------------- whisper

function Get-ZeroWhisperCandidates {
    <#
        Every place a Windows whisper.cpp actually ends up.

        A CMake build puts it under `build\bin\Release`; a Ninja or MinGW build
        puts it under `build\bin`. Both are normal, so both are looked at
        rather than one being declared correct.
    #>
    param([string]$HomeDir)
    if (-not $HomeDir) { $HomeDir = Get-ZeroHomeDirectory }
    $candidates = @()
    if ($env:ZERO_WHISPER_BIN) { $candidates += $env:ZERO_WHISPER_BIN }
    foreach ($relative in @(
            '.local\bin\whisper-cli.exe',
            'whisper.cpp\build\bin\Release\whisper-cli.exe',
            'whisper.cpp\build\bin\whisper-cli.exe',
            'whisper.cpp\build\Release\whisper-cli.exe',
            'whisper.cpp\build\bin\Release\main.exe',
            'whisper.cpp\build\bin\main.exe',
            '.local\bin\whisper-cli',
            'whisper.cpp\build\bin\whisper-cli'
        )) {
        # `[IO.Path]::Combine` rather than `Join-Path`: Join-Path is provider
        # aware and fails outright on a path whose drive is not mounted, which
        # makes building a *candidate* list impossible on the one occasion it
        # matters. This is string work and nothing else.
        $candidates += ([System.IO.Path]::Combine($HomeDir, $relative))
    }
    return $candidates
}

function Get-ZeroHomeDirectory {
    <# $HOME is not set for every Windows shell; USERPROFILE always is. #>
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    if ($env:HOME) { return $env:HOME }
    return [Environment]::GetFolderPath('UserProfile')
}

function Get-ZeroWhisperBinary {
    <# The whisper.cpp binary, or nothing. Explicit setting, PATH, then disk. #>
    param([string]$HomeDir)
    if ($env:ZERO_WHISPER_BIN -and (Test-Path -LiteralPath $env:ZERO_WHISPER_BIN)) {
        return $env:ZERO_WHISPER_BIN
    }
    foreach ($name in @('whisper-cli.exe', 'whisper-cli', 'whisper.exe', 'main.exe')) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($command) { return $command.Source }
    }
    foreach ($candidate in (Get-ZeroWhisperCandidates -HomeDir $HomeDir)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

function Test-ZeroWhisperBinary {
    <#
        Does it actually run here?

        A file that exists is not an engine. A build for the wrong architecture,
        a missing runtime DLL, a half-finished copy — all of them pass
        `Test-Path` and fail the moment audio arrives. Asking it to print its
        usage costs a second and turns a mid-utterance failure into a startup
        one.
    #>
    param([Parameter(Mandatory = $true)][string]$Path, [int]$TimeoutSec = 15)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ Ok = $false; Detail = 'the binary is not there' }
    }
    $stdout = [System.IO.Path]::GetTempFileName()
    $stderr = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $Path -ArgumentList '--help' -PassThru -NoNewWindow `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            try { $process.Kill() } catch { }
            return [pscustomobject]@{ Ok = $false; Detail = "it did not answer --help within ${TimeoutSec}s" }
        }
        $output = ''
        foreach ($file in @($stdout, $stderr)) {
            if (Test-Path -LiteralPath $file) {
                $output += (Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue)
            }
        }
        # whisper.cpp exits non-zero on --help; the usage text is the proof,
        # not the exit code.
        if ($output -match '(?i)usage|whisper') {
            $first = ($output -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
            return [pscustomobject]@{ Ok = $true; Detail = ([string]$first).Trim() }
        }
        return [pscustomobject]@{ Ok = $false; Detail = 'it ran but did not look like whisper.cpp' }
    } catch {
        return [pscustomobject]@{ Ok = $false; Detail = $_.Exception.Message }
    } finally {
        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    }
}

function Get-ZeroWhisperModelCandidates {
    param([string]$HomeDir)
    if (-not $HomeDir) { $HomeDir = Get-ZeroHomeDirectory }
    $candidates = @()
    if ($env:ZERO_WHISPER_MODEL) { $candidates += $env:ZERO_WHISPER_MODEL }
    foreach ($relative in @(
            '.cache\whisper.cpp\ggml-tiny.bin',
            '.local\share\whisper.cpp\ggml-tiny.bin',
            'whisper.cpp\models\ggml-tiny.bin',
            '.cache\whisper.cpp\ggml-base.bin',
            'whisper.cpp\models\ggml-base.bin'
        )) {
        $candidates += ([System.IO.Path]::Combine($HomeDir, $relative))
    }
    return $candidates
}

function Get-ZeroWhisperModel {
    param([string]$HomeDir)
    foreach ($candidate in (Get-ZeroWhisperModelCandidates -HomeDir $HomeDir)) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    return $null
}

function Test-ZeroWhisperModel {
    <#
        Is this file a model, or a saved error page?

        A truncated download and an HTML 404 both arrive with a success exit
        code. Both then fail every single voice turn with an error that says
        nothing about the download, which is the worst possible way to find
        out. Size, and a look at the first bytes, settles it here instead.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MinimumBytes = 20000000
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ Ok = $false; Reason = 'missing'; SizeMb = 0 }
    }
    $size = (Get-Item -LiteralPath $Path).Length
    $sizeMb = [int][math]::Round($size / 1MB)
    if ($size -lt $MinimumBytes) {
        return [pscustomobject]@{ Ok = $false; Reason = 'truncated'; SizeMb = $sizeMb }
    }
    $head = ''
    try {
        $bytes = Get-Content -LiteralPath $Path -Encoding Byte -TotalCount 512 -ErrorAction Stop
        $head = [System.Text.Encoding]::ASCII.GetString($bytes)
    } catch {
        # PowerShell 7 dropped -Encoding Byte in favour of -AsByteStream.
        try {
            $bytes = Get-Content -LiteralPath $Path -AsByteStream -TotalCount 512 -ErrorAction Stop
            $head = [System.Text.Encoding]::ASCII.GetString($bytes)
        } catch {
            $head = ''
        }
    }
    if ($head -match '(?i)<!doctype|<html|<\?xml|Not Found') {
        return [pscustomobject]@{ Ok = $false; Reason = 'html'; SizeMb = $sizeMb }
    }
    return [pscustomobject]@{ Ok = $true; Reason = 'ok'; SizeMb = $sizeMb }
}

# ------------------------------------------------------------------- backoff

function Get-ZeroBackoffSeconds {
    <#
        The nth restart delay, with the last step repeating forever.

        1, 2, 5, 10, 15 and then 15 again. A backend that dies instantly over
        and over is a broken install; retrying it sixty times a minute hides
        the error and, on a laptop, spends the battery doing it.
    #>
    param([Parameter(Mandatory = $true)][int]$Attempt)
    $steps = @(1, 2, 5, 10, 15)
    if ($Attempt -lt 1) { return $steps[0] }
    if ($Attempt -ge $steps.Count) { return $steps[$steps.Count - 1] }
    return $steps[$Attempt - 1]
}

# ------------------------------------------------------------------- output

function Write-ZeroStep { param([string]$Text) Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Write-ZeroOk { param([string]$Text) Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Write-ZeroWarn { param([string]$Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-ZeroBad { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }
function Write-ZeroNote { param([string]$Text) Write-Host "         $Text" -ForegroundColor DarkGray }

# -------------------------------------------------------------- event stream

function Test-ZeroEventStream {
    <#
        Open the operator's event socket and see what it says first.

        "FULL" is not a label the scripts are free to award. It means the same
        thing here as in the interface: the stream is open *and* the runtime
        announced itself on it — `zero.runtime.ready` as the opening frame. An
        open socket that has said nothing is `partial`, and no socket at all is
        `offline`. Reporting FULL without checking would be exactly the kind of
        fake ready state this whole exercise exists to remove.
    #>
    param(
        [Parameter(Mandatory = $true)][int]$UiPort,
        [int]$TimeoutSec = 8
    )
    $offline = [pscustomobject]@{ Level = 'offline'; Detail = 'the event socket did not open' }
    $socket = $null
    try {
        $socket = New-Object System.Net.WebSockets.ClientWebSocket
    } catch {
        return [pscustomobject]@{ Level = 'unknown'; Detail = 'this PowerShell has no WebSocket client' }
    }
    $cancel = New-Object System.Threading.CancellationTokenSource
    $cancel.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
    try {
        $uri = [Uri]"ws://127.0.0.1:$UiPort/ws/events"
        $connect = $socket.ConnectAsync($uri, $cancel.Token)
        if (-not $connect.Wait([int]($TimeoutSec * 1000))) { return $offline }
        if ($socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) { return $offline }

        $buffer = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, (New-Object byte[] 16384))
        $receive = $socket.ReceiveAsync($buffer, $cancel.Token)
        if (-not $receive.Wait([int]($TimeoutSec * 1000))) {
            return [pscustomobject]@{ Level = 'partial'; Detail = 'open, but nothing was announced' }
        }
        $count = $receive.Result.Count
        $text = [System.Text.Encoding]::UTF8.GetString($buffer.Array, 0, $count)
        $type = ''
        try { $type = [string]($text | ConvertFrom-Json).type } catch { $type = '' }
        if ($type -eq 'zero.runtime.ready') {
            return [pscustomobject]@{ Level = 'full'; Detail = 'ZeroSession announced itself' }
        }
        return [pscustomobject]@{ Level = 'partial'; Detail = "first frame was '$type'" }
    } catch {
        return [pscustomobject]@{ Level = 'offline'; Detail = $_.Exception.Message }
    } finally {
        if ($socket) {
            try { $socket.Abort() } catch { }
            try { $socket.Dispose() } catch { }
        }
        try { $cancel.Dispose() } catch { }
    }
}

# ------------------------------------------------------------------- summary

function Get-ZeroRuntimeSummary {
    <#
        Every state the final block prints, read from the running system.

        Nothing here is inferred from "we started it, so it must be up". Each
        line is a question asked of the thing itself, because the whole point
        of the block is that the operator can trust it.
    #>
    param([Parameter(Mandatory = $true)]$Config, $Paths)
    if (-not $Paths) { $Paths = Get-ZeroPaths }
    $health = "http://127.0.0.1:$($Config.UiPort)/api/health"
    $base = "http://127.0.0.1:$($Config.UiPort)/api"

    $gateway = 'OFFLINE'
    if (Test-ZeroHttp -Url $health) { $gateway = 'HEALTHY' }

    $zeroState = Get-ZeroHealthField -Url $health -Field 'zero'
    $backend = 'OFFLINE'
    if ($zeroState -eq 'healthy') { $backend = 'HEALTHY' }

    $runtime = 'OFFLINE'
    $runtimeReady = Get-ZeroHealthField -Url "$base/runtime" -Field 'ready'
    if ($runtimeReady -eq $true) { $runtime = 'ONLINE' }

    $stream = 'OFFLINE'
    if ($backend -eq 'HEALTHY') {
        $stream = (Test-ZeroEventStream -UiPort $Config.UiPort).Level.ToUpper()
    }

    $whisperBinary = Get-ZeroWhisperBinary
    $whisper = 'MISSING'
    if ($whisperBinary) {
        if ((Test-ZeroWhisperBinary -Path $whisperBinary).Ok) { $whisper = 'READY' } else { $whisper = 'UNUSABLE' }
    }
    $modelPath = Get-ZeroWhisperModel
    $model = 'MISSING'
    if ($modelPath) {
        $check = Test-ZeroWhisperModel -Path $modelPath
        if ($check.Ok) { $model = (Split-Path -Leaf $modelPath) } else { $model = "INVALID ($($check.Reason))" }
    }

    # STT, reasoning and voice come from the runtime itself rather than from
    # what is on disk here: the engine ZERO will actually use is the one it
    # reports, not the one this script happened to find.
    $voice = 'UNKNOWN'
    $stt = 'UNKNOWN'
    $reasoning = 'UNKNOWN'
    $voiceResult = Invoke-ZeroHttp -Url "$base/voice/status"
    if ($voiceResult.Answered -and $voiceResult.Body) {
        try {
            $payload = $voiceResult.Body | ConvertFrom-Json
            if ($payload.voice) { $voice = ([string]$payload.voice).ToUpper() }
            if ($payload.stt) {
                if ($payload.stt.ready -eq $true) { $stt = 'READY' }
                else { $stt = ([string]$payload.stt.reason).ToUpper() }
            }
            if ($payload.reasoning -and $payload.reasoning.provider) {
                $reasoning = [string]$payload.reasoning.provider
            }
        } catch { }
    }

    $agents = 'UNKNOWN'
    $agentResult = Invoke-ZeroHttp -Url "$base/agents/children"
    if ($agentResult.Answered -and $agentResult.Body) {
        try {
            $payload = $agentResult.Body | ConvertFrom-Json
            $agents = "$(@($payload.repositories).Count) DISCOVERED"
        } catch { }
    }

    $supervisor = 'STOPPED'
    if ($null -ne (Get-ZeroLivePid -Path $Paths.SupervisorPid)) { $supervisor = 'RUNNING' }

    return [pscustomobject]@{
        Interface    = $Config.InterfaceUrl
        Gateway      = $gateway
        Backend      = $backend
        Runtime      = $runtime
        EventStream  = $stream
        Whisper      = $whisper
        WhisperModel = $model
        Stt          = $stt
        Reasoning    = $reasoning
        Voice        = $voice
        Agents       = $agents
        Supervisor   = $supervisor
        Online       = ($gateway -eq 'HEALTHY')
    }
}

function Write-ZeroReadyBlock {
    <# The final block. Every value is measured; none is assumed. #>
    param([Parameter(Mandatory = $true)]$Summary)
    $line = '========================================'
    $headline = 'ZERO ONLINE'
    if (-not $Summary.Online) { $headline = 'ZERO GATEWAY OFFLINE' }
    elseif ($Summary.Backend -ne 'HEALTHY') { $headline = 'ZERO ONLINE - BACKEND OFFLINE' }

    Write-Host ''
    Write-Host $line
    Write-Host 'HWD | ZERO - WINDOWS'
    Write-Host $line
    Write-Host ''
    Write-Host $headline
    foreach ($pair in @(
            @('INTERFACE', $Summary.Interface),
            @('GATEWAY', $Summary.Gateway),
            @('HWD-ZERO', $Summary.Backend),
            @('ZERO RUNTIME', $Summary.Runtime),
            @('EVENT STREAM', $Summary.EventStream),
            @('WHISPER', $Summary.Whisper),
            @('WHISPER MODEL', $Summary.WhisperModel),
            @('STT', $Summary.Stt),
            @('REASONING', $Summary.Reasoning),
            @('VOICE', $Summary.Voice),
            @('AGENTS', $Summary.Agents),
            @('SUPERVISOR', $Summary.Supervisor)
        )) {
        Write-Host ''
        Write-Host $pair[0]
        Write-Host $pair[1]
    }
    Write-Host ''
    Write-Host $line
}
