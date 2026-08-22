<#
.SYNOPSIS
    From a ThinkPad with nothing set up to a running, speaking ZERO - one command.

.DESCRIPTION
    The Windows counterpart of scripts/zero-termux-one-shot.sh. It updates both
    repositories, checks the toolchain, prepares HWD-ZERO, finds or builds
    whisper.cpp, fetches a model, cleans up its own stale run state, starts the
    gateway and the runtime, and then reports what is actually true.

    What it refuses to do, and why:

      - **Never discards local work.** `git pull --ff-only`, and if the working
        tree is dirty the pull is skipped and said so. No `reset --hard`, no
        `clean -fd`. Losing the operator's uncommitted change to save a fetch
        is not a trade this script is allowed to make.
      - **Never a global kill.** No `taskkill /F /IM node.exe`. Every process
        it stops it started, identified by pid file and verified first.
      - **Never touches Windows itself.** No execution-policy change beyond
        this one process, no firewall rule, no Defender exclusion, no registry
        edit, no UAC prompt it did not have to raise. ZERO runs on an ordinary
        Windows 11 account or it does not run.
      - **Never accepts a model on faith.** A truncated download and an HTML
        error page both arrive with a success exit code; the file is checked
        and deleted rather than half-installed.
      - **`-j 2` when building.** A laptop that compiles on every core throttles
        and, on a small machine, runs out of memory instead of finishing.

    Safe to re-run: every step checks before it acts.

.PARAMETER Branch
    The branch to update both repositories to.

.PARAMETER SkipUpdate
    Do not touch git at all.

.PARAMETER SkipWhisper
    Do not build or download anything for speech. Voice stays off.

.PARAMETER SkipInstall
    Never call winget, even when something is missing.

.PARAMETER Lan
    Serve on the LAN as well as loopback. Off by default.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\zero-windows-one-shot.ps1
#>
[CmdletBinding()]
param(
    [string]$Branch = 'claude/zero-termux-runtime-fix',
    [switch]$SkipUpdate,
    [switch]$SkipWhisper,
    [switch]$SkipInstall,
    [switch]$Lan,
    [switch]$NoSupervise
)

. (Join-Path $PSScriptRoot 'lib-zero.ps1')
# A bootstrap reports what failed and carries on with what it can. A blanket
# `Stop` would abandon a working install over one optional package.
$ErrorActionPreference = 'Continue'

$script:Step = 0
function Step {
    param([string]$Text)
    $script:Step++
    Write-Host ''
    Write-Host ('{0,2} - {1}' -f $script:Step, $Text) -ForegroundColor Cyan
}
function Ok { param([string]$Text) Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Bad { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }
function Note { param([string]$Text) Write-Host "         $Text" -ForegroundColor DarkGray }

$paths = Get-ZeroPaths
$config = Get-ZeroConfig -Root $paths.Root
$homeDir = Get-ZeroHomeDirectory
$whisperSource = Join-Path $homeDir 'whisper.cpp'
$modelDir = Join-Path $homeDir '.cache\whisper.cpp'
$modelPath = Join-Path $modelDir 'ggml-tiny.bin'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
# A tiny model is roughly 75 MB. An HTML error page is a few kilobytes.
$minimumModelBytes = 20000000
$blocked = @()

Write-Host ''
Write-Host 'HWD | ZERO - WINDOWS ONE-SHOT' -ForegroundColor White

# ---------------------------------------------------------------- 1 platform
Step 'WINDOWS'
if (Test-ZeroIsWindows) {
    $caption = 'Windows'
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $caption = "$($os.Caption) build $($os.BuildNumber)"
    } catch { }
    Ok $caption
} else {
    Warn 'this is not Windows - the script will run what it can and skip the rest'
}
Ok "powershell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Bad 'PowerShell 5.1 is the minimum'
    exit 1
}

# --------------------------------------------------------------- 2 workspace
Step 'WORKSPACE'
Ok "root       $($paths.Root)"
Ok "workspace  $($paths.Workspace)"
Ok "runtime    $($paths.RuntimeDir)"
Ok "home       $homeDir"

# ------------------------------------------------------------ 3 repositories
Step 'REPOSITORIES'
$repositories = @(
    @{ Name = 'brain-interface'; Path = $paths.Root; Marker = 'package.json' },
    @{ Name = 'HWD-ZERO'; Path = $paths.RuntimeDir; Marker = 'zero' }
)
foreach ($repo in $repositories) {
    if (Test-Path -LiteralPath (Join-Path $repo.Path $repo.Marker)) {
        Ok "$($repo.Name) at $($repo.Path)"
    } else {
        Warn "$($repo.Name) is not checked out at $($repo.Path)"
        Note "git clone https://github.com/ChrisTheKey/$($repo.Name) `"$($repo.Path)`""
    }
}

# ---------------------------------------------------------------- 4 winget
function Install-IfMissing {
    <#
        Offer winget one package, user scope where the package allows it.

        Never silently: what is being installed is printed first. And never a
        substitute for the operator's judgement - if winget is absent or the
        install fails, the missing dependency is named and the script says so.
    #>
    param([string]$Command, [string]$WingetId, [string]$Label)
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return $true }
    if ($SkipInstall) {
        Warn "$Label is missing (-SkipInstall, so nothing was installed)"
        return $false
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Bad "$Label is missing and winget is not available to install it"
        Note "install $Label manually, then re-run this script"
        return $false
    }
    Warn "installing $Label via winget ($WingetId)"
    # `--scope user` avoids an elevation prompt where the package supports it;
    # winget falls back on its own when it does not, and no UAC is bypassed.
    & winget install --id $WingetId --scope user --accept-package-agreements --accept-source-agreements --silent 2>&1 |
        Out-Null
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        # winget updates PATH for *new* shells; this one may still not see it.
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        Ok "$Label installed"
        return $true
    }
    Bad "$Label could not be installed automatically"
    Note "install it yourself, then re-run: winget install --id $WingetId"
    return $false
}

# ------------------------------------------------------------------- 5 git
Step 'GIT'
$hasGit = Install-IfMissing -Command 'git' -WingetId 'Git.Git' -Label 'Git'
if ($hasGit) { Ok (& git --version) }

# ------------------------------------------------------------ 6 branch/update
Step 'REPOSITORY UPDATE'
if ($SkipUpdate) {
    Ok 'skipped (-SkipUpdate)'
} elseif (-not $hasGit) {
    Warn 'git is unavailable - repositories were not updated'
} else {
    foreach ($repo in $repositories) {
        if (-not (Test-Path -LiteralPath (Join-Path $repo.Path '.git'))) {
            Warn "$($repo.Name) is not a git checkout - skipped"
            continue
        }
        $dirty = (& git -C $repo.Path status --porcelain 2>$null)
        if ($dirty) {
            # The operator's uncommitted work is never this script's to
            # discard. Saying so and moving on beats a clever recovery.
            Warn "$($repo.Name) has uncommitted changes - not updating it"
            Note 'commit or stash them yourself, then re-run. Nothing was deleted.'
            continue
        }
        & git -C $repo.Path fetch origin 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Warn "$($repo.Name): fetch failed - continuing with what is on disk"
            continue
        }
        $current = (& git -C $repo.Path rev-parse --abbrev-ref HEAD 2>$null)
        if ($current -ne $Branch) {
            $remoteRef = "origin/$Branch"
            $exists = (& git -C $repo.Path rev-parse --verify --quiet $remoteRef 2>$null)
            if (-not $exists) {
                Warn "$($repo.Name): $remoteRef does not exist - staying on $current"
                continue
            }
            & git -C $repo.Path checkout -B $Branch $remoteRef 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Warn "$($repo.Name): could not switch to $Branch - staying on $current"
                continue
            }
        }
        # Fast-forward only. A merge commit made by a bootstrap script is a
        # surprise nobody asked for.
        & git -C $repo.Path pull --ff-only origin $Branch 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Warn "$($repo.Name): not fast-forwardable - resolve it yourself; nothing was reset"
        }
        $head = (& git -C $repo.Path rev-parse --short HEAD 2>$null)
        Ok "$($repo.Name) on $Branch at $head"
    }
}

# ---------------------------------------------------------------- 7 python
Step 'PYTHON'
$hasPython = $false
$python = $null
foreach ($candidate in @((Join-Path $paths.RuntimeDir '.venv\Scripts\python.exe'), 'py', 'python', 'python3')) {
    if ($candidate -like '*\*') {
        if (Test-Path -LiteralPath $candidate) { $python = $candidate; break }
    } elseif (Get-Command $candidate -ErrorAction SilentlyContinue) { $python = $candidate; break }
}
if (-not $python) {
    if (Install-IfMissing -Command 'python' -WingetId 'Python.Python.3.12' -Label 'Python 3.12') {
        $python = 'python'
    }
}
if ($python) {
    Ok "$(& $python --version 2>&1) ($python)"
    $hasPython = $true
} else {
    Warn 'python is missing - the interface will still serve, HWD-ZERO will not start'
}

# ------------------------------------------------------------------ 8 node
Step 'NODE'
$hasNode = Install-IfMissing -Command 'node' -WingetId 'OpenJS.NodeJS.LTS' -Label 'Node.js LTS'
if ($hasNode) {
    $nodeVersion = (& node -v)
    $nodeMajor = 0
    if ($nodeVersion -match '^v(\d+)') { $nodeMajor = [int]$Matches[1] }
    if ($nodeMajor -lt 20) {
        Bad "node $nodeVersion is too old - the gateway needs 20.19 or newer"
        exit 1
    }
    Ok "node $nodeVersion"
} else {
    Bad 'node is required to serve the interface'
    exit 1
}

# ------------------------------------------------------------------- 9 npm
Step 'NPM'
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Ok "npm $(& npm -v)"
} else {
    Bad 'npm is missing even though node is installed'
    exit 1
}

# ------------------------------------------------------------- 10 hwd-zero
Step 'HWD-ZERO INSTALL'
if (-not $hasPython) {
    Warn 'skipped - no python'
} elseif (-not (Test-Path -LiteralPath (Join-Path $paths.RuntimeDir 'zero'))) {
    Warn "skipped - HWD-ZERO is not checked out at $($paths.RuntimeDir)"
} else {
    Push-Location -LiteralPath $paths.RuntimeDir
    & $python -c 'import zero.server' *> $null
    $importable = ($LASTEXITCODE -eq 0)
    if (-not $importable) {
        Warn 'installing HWD-ZERO in editable mode'
        & $python -m pip install -e . *>> $paths.BuildLog
        & $python -c 'import zero.server' *> $null
        $importable = ($LASTEXITCODE -eq 0)
    }
    Pop-Location
    if ($importable) { Ok 'python -m zero.server is importable' }
    else {
        Bad 'zero.server still cannot be imported'
        Note "run it by hand to see why: cd `"$($paths.RuntimeDir)`"; $python -m pip install -e ."
        Get-ZeroLogTail -Path $paths.BuildLog -Lines 20 | ForEach-Object { Note $_ }
    }
}

# --------------------------------------------------------- 11 npm dependencies
Step 'INTERFACE DEPENDENCIES'
if (Test-Path -LiteralPath (Join-Path $paths.Root 'node_modules')) {
    Ok 'node_modules is present'
} else {
    Warn 'installing npm dependencies (the slow part)'
    Push-Location -LiteralPath $paths.Root
    & npm install *>> $paths.BuildLog
    $installed = ($LASTEXITCODE -eq 0)
    Pop-Location
    if ($installed) { Ok 'installed' }
    else {
        Bad 'npm install failed'
        Get-ZeroLogTail -Path $paths.BuildLog -Lines 25 | ForEach-Object { Note $_ }
        exit 1
    }
}

# ---------------------------------------------------------------- 12 whisper
Step 'WHISPER'
$whisper = Get-ZeroWhisperBinary -HomeDir $homeDir
if ($SkipWhisper) {
    Warn 'skipped (-SkipWhisper) - voice input stays off'
} elseif ($whisper -and (Test-ZeroWhisperBinary -Path $whisper).Ok) {
    Ok "already built and runs: $whisper"
} else {
    if ($whisper) { Warn "$whisper exists but does not run - rebuilding" }
    $hasCmake = Install-IfMissing -Command 'cmake' -WingetId 'Kitware.CMake' -Label 'CMake'
    if (-not $hasGit -or -not $hasCmake) {
        Warn 'git and cmake are both needed to build whisper.cpp - voice stays off'
    } else {
        if (-not (Test-Path -LiteralPath (Join-Path $whisperSource '.git'))) {
            Warn "cloning whisper.cpp (shallow) into $whisperSource"
            & git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git $whisperSource 2>&1 | Out-Null
        }
        if (Test-Path -LiteralPath $whisperSource) {
            Warn 'building with -j 2 (more cores throttle a laptop and exhaust its RAM)'
            Push-Location -LiteralPath $whisperSource
            & cmake -B build -DCMAKE_BUILD_TYPE=Release *>> $paths.BuildLog
            if ($LASTEXITCODE -eq 0) {
                & cmake --build build --config Release -j 2 *>> $paths.BuildLog
            }
            Pop-Location
            $whisper = Get-ZeroWhisperBinary -HomeDir $homeDir
            if ($whisper) {
                # Symlinks need a privilege an ordinary account does not have,
                # so the binary is copied where discovery already looks.
                $binDir = Join-Path $homeDir '.local\bin'
                if (-not (Test-Path -LiteralPath $binDir)) {
                    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
                }
                $target = Join-Path $binDir (Split-Path -Leaf $whisper)
                if ($whisper -ne $target) {
                    Copy-Item -LiteralPath $whisper -Destination $target -Force -ErrorAction SilentlyContinue
                }
                Ok "built: $whisper"
            } else {
                Bad 'the build produced no binary'
                Note "cd `"$whisperSource`"; cmake -B build; cmake --build build --config Release -j 2"
                Get-ZeroLogTail -Path $paths.BuildLog -Lines 25 | ForEach-Object { Note $_ }
            }
        }
    }
}

# ----------------------------------------------------------- 13 whisper model
Step 'SPEECH MODEL'
if ($SkipWhisper) {
    Warn 'skipped (-SkipWhisper)'
} else {
    $existing = Get-ZeroWhisperModel -HomeDir $homeDir
    if ($existing) {
        $check = Test-ZeroWhisperModel -Path $existing -MinimumBytes $minimumModelBytes
        if ($check.Ok) {
            Ok "$(Split-Path -Leaf $existing) present ($($check.SizeMb) MB)"
        } else {
            # Never leave a half-file behind: whisper would fail every turn
            # with an error that says nothing about the download.
            Bad "$existing is not a usable model ($($check.Reason)) - deleting it"
            Remove-Item -LiteralPath $existing -Force -ErrorAction SilentlyContinue
            $existing = $null
        }
    }
    if (-not $existing) {
        if (-not (Test-Path -LiteralPath $modelDir)) {
            New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
        }
        Warn 'downloading ggml-tiny.bin (~75 MB) - deliberate, once, and never automatic later'
        $partial = "$modelPath.part"
        try {
            $progress = $ProgressPreference
            # The progress bar makes Invoke-WebRequest an order of magnitude
            # slower on 5.1 for a download this size.
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $modelUrl -OutFile $partial -UseBasicParsing -ErrorAction Stop
            $ProgressPreference = $progress
        } catch {
            Bad "the download failed: $($_.Exception.Message)"
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $partial) {
            Move-Item -LiteralPath $partial -Destination $modelPath -Force
            $check = Test-ZeroWhisperModel -Path $modelPath -MinimumBytes $minimumModelBytes
            if ($check.Ok) {
                Ok "downloaded ($($check.SizeMb) MB)"
            } else {
                Bad "the download is not a valid model ($($check.Reason)) - deleting it rather than half-installing"
                Remove-Item -LiteralPath $modelPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# ------------------------------------------------------------- 14 run state
Step 'RUN STATE'
foreach ($entry in @(
        @{ Name = 'gateway'; Path = $paths.GatewayPid },
        @{ Name = 'hwd-zero'; Path = $paths.ZeroPid },
        @{ Name = 'supervisor'; Path = $paths.SupervisorPid }
    )) {
    $live = Get-ZeroLivePid -Path $entry.Path
    if ($null -ne $live) {
        Ok "$($entry.Name) is already running (pid $live)"
    } elseif (Clear-ZeroStalePid -Path $entry.Path) {
        Warn "removed a stale $($entry.Name) pid file - nothing was killed"
    } else {
        Ok "$($entry.Name) is not running"
    }
}

# ----------------------------------------------------------------- 15 ports
Step 'PORTS'
foreach ($entry in @(
        @{ Name = 'interface'; Port = $config.UiPort; PidFile = $paths.GatewayPid },
        @{ Name = 'hwd-zero'; Port = $config.ApiPort; PidFile = $paths.ZeroPid }
    )) {
    if (-not (Test-ZeroPortBusy -Port $entry.Port)) {
        Ok "$($entry.Name) port $($entry.Port) is free"
        continue
    }
    $zero = Get-ZeroServiceOnPort -Port $entry.Port
    $owner = Get-ZeroPortOwner -Port $entry.Port
    $recorded = Get-ZeroLivePid -Path $entry.PidFile
    if ($null -ne $zero) {
        Ok "$($entry.Name) port $($entry.Port) - HWD-ZERO (pid $($zero.ProcessId)) - will be adopted"
    } elseif ($null -ne $owner -and $null -ne $recorded -and $owner.ProcessId -eq $recorded) {
        Ok "$($entry.Name) port $($entry.Port) - ours (pid $($owner.ProcessId))"
    } else {
        Bad "PORT $($entry.Port) BLOCKED"
        if ($null -ne $owner) {
            Note "PID        $($owner.ProcessId)"
            Note "PROCESS    $($owner.ProcessName)"
        } else {
            Note 'PID        unknown'
            Note 'PROCESS    unknown'
        }
        Note 'REASON     foreign process'
        Note 'ZERO will not stop a process it did not start.'
        $blocked += $entry.Port
    }
}
if ($blocked.Count -gt 0) {
    Write-Host ''
    Bad "ports $($blocked -join ', ') are held by processes ZERO did not start - stopping here"
    exit 1
}

# ----------------------------------------------------------------- 16 start
Step 'START'
$startArgs = @()
if ($Lan) { $startArgs += '-Lan' }
if ($NoSupervise) { $startArgs += '-NoSupervise' }
& (Join-Path $PSScriptRoot 'zero-windows-start.ps1') @startArgs
$startExit = $LASTEXITCODE

# ---------------------------------------------------------------- 17 doctor
Step 'DIAGNOSIS'
& (Join-Path $PSScriptRoot 'zero-windows-doctor.ps1')
$doctorExit = $LASTEXITCODE

# ----------------------------------------------------------------- 18 verdict
Write-Host ''
Write-Host 'ONE-SHOT COMPLETE' -ForegroundColor White
Write-Host "  interface  $($config.InterfaceUrl)"
Write-Host "  status     powershell -NoProfile -File `"$(Join-Path $PSScriptRoot 'zero-windows-status.ps1')`""
Write-Host "  doctor     powershell -NoProfile -File `"$(Join-Path $PSScriptRoot 'zero-windows-doctor.ps1')`""
Write-Host "  stop       powershell -NoProfile -File `"$(Join-Path $PSScriptRoot 'zero-windows-stop.ps1')`""
Write-Host "  logs       $($paths.LogDir)"

if ($startExit -ne 0 -or $doctorExit -ne 0) {
    Write-Host ''
    Write-Host 'Something above is not right. The tails are printed with the failure;' -ForegroundColor Yellow
    Write-Host 'zero-windows-doctor names the remedy for each.' -ForegroundColor Yellow
    exit 1
}
exit 0
