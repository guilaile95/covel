# Gate A (Dongfang) one-click test runner.
# Owner only needs to: run this script -> play in the browser -> come back and press Enter.
#
# Usage:
#   .\scripts\dongfang\start-gate-a.ps1            # Memory OFF turn (default)
#   .\scripts\dongfang\start-gate-a.ps1 -Memory on # Memory ON turn
#
# What it does:
#   1. kills leftover covel-spike dev processes on ports 3001/5173
#   2. first-run guidance for llm.toml / .env.llm (API key, same model as your
#      plain-Chat A path!)
#   3. sets COVEL_MEMORY_UPDATES per -Memory, starts `pnpm dev`, waits healthy
#   4. opens the browser at the web UI
#   5. after each play session (press Enter), auto-collects every session you
#      created this run and writes per-session call/token/latency stats under
#      gate-results\
#   6. 'q' at the prompt stops the dev services and prints where results live

param(
    [ValidateSet("off", "on")]
    [string]$Memory = "off",
    # smoke-test switch: no interactive prompts — start, collect once, stop.
    [switch]$AutoQuit
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # covel-spike root
Set-Location $repo

$ports = @(3001, 5173)
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$resultsDir = Join-Path $repo "gate-results\memory-$Memory-$runId"
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$runStart = (Get-Date).ToUniversalTime().ToString("o")

function Get-PortPid([int]$p) {
    $line = (netstat -ano | Select-String ":$p\s.*LISTENING" | Select-Object -First 1)
    if ($line) { return ($line.ToString().Trim() -split "\s+")[-1] }
    return $null
}

# ── 1. leftover covel dev processes ─────────────────────────────
foreach ($p in $ports) {
    $pid2 = Get-PortPid $p
    if ($pid2) {
        $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2").CommandLine
        if ($cmdline -and $cmdline -match "covel-spike") {
            Write-Host "[cleanup] killing leftover covel-spike process (port $p, pid $pid2)"
            Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue
        } else {
            Write-Host "[abort] port $p is used by a non-covel process (pid $pid2): $cmdline"
            Write-Host "        close it yourself, then re-run."
            exit 1
        }
    }
}

# ── 2. model config happens in the browser Settings UI ─────────
# No file editing: Covel ships a default story slot and the Settings UI
# (provider keys / model slots) persists the Owner's choice. The hard rule
# stays: pick the SAME model as the plain-Chat A path.

# ── 3. start dev services ───────────────────────────────────────
$env:COVEL_MEMORY_UPDATES = $Memory
Write-Host "[run] memory updates: $Memory"
Write-Host "[run] starting pnpm dev ..."
$dev = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm dev" -WorkingDirectory $repo `
    -WindowStyle Minimized -PassThru -RedirectStandardOutput (Join-Path $resultsDir "dev.log") `
    -RedirectStandardError (Join-Path $resultsDir "dev.err")

# ── 4. wait healthy, then open browser ──────────────────────────
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-WebRequest -Uri "http://localhost:3001/api/health" -UseBasicParsing -TimeoutSec 3
        if ($h.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
}
if (-not $healthy) {
    Write-Host "[abort] dev server did not become healthy — see dev.log in $resultsDir"
    if ($dev -and !$dev.HasExited) { Stop-Process -Id $dev.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}
# Discover the actual web URL from the dev log (5173 may be taken by another
# worktree, in which case vite shifts to 5174+).
$webPort = 5173
$devLogPath = Join-Path $resultsDir "dev.log"
for ($i = 0; $i -lt 10; $i++) {
    if (Test-Path $devLogPath) {
        $m = Select-String -Path $devLogPath -Pattern "localhost:(\d+)/" | Select-Object -First 1
        if ($m) { $webPort = [int]$m.Matches[0].Groups[1].Value; break }
    }
    Start-Sleep -Seconds 1
}
Start-Process "http://localhost:$webPort/"
Write-Host ""
Write-Host "==============================================================="
Write-Host " Browser is open at http://localhost:$webPort/ . First visit:"
Write-Host "   -> open Settings -> model/provider panels -> pick the SAME"
Write-Host "      model you will use in the plain-Chat A path, paste your"
Write-Host "      API key there (stored in your browser, not in the repo)."
Write-Host ""
Write-Host " Then play:"
Write-Host "   1. pick the world: 直玩（提示词透传） / Prompt Play (Passthrough)"
Write-Host "   2. expect NO char-creation form; the prompt hosts creation itself"
Write-Host "   3. free-play at least 5 natural turns (no scripted lines, no rerolls)"
Write-Host "   4. A path reminder: paste worlds\prompt-play\WORLD.zh.md verbatim"
Write-Host "      into the SAME model in a plain chat, play 5+ turns there too"
Write-Host "   5. test save/resume: close the browser, reopen, continue the session"
Write-Host ""
Write-Host " After each play session come back here and press Enter to collect stats."
Write-Host "==============================================================="

function Collect-Sessions {
    $resp = Invoke-RestMethod -Uri "http://localhost:3001/api/sessions?worldId=prompt-play" -TimeoutSec 10
    $items = $resp.items
    if (-not $items) { Write-Host "[collect] no sessions found."; return }
    $new = @($items | Where-Object { [datetime]$_.createdAt -ge [datetime]$runStart })
    if ($new.Count -eq 0) { Write-Host "[collect] no NEW sessions since this run started."; return }
    $reportLines = @(
        "# Gate A run report",
        "",
        "- run: $runId",
        "- memory mode: **$Memory**",
        "- started (UTC): $runStart",
        "- collected (UTC): $((Get-Date).ToUniversalTime().ToString('o'))",
        "- model/provider: as configured in the browser Settings UI (same as the plain-Chat A path); llm.toml story slot: $(Get-StorySlotSummary)",
        "",
        "## Sessions",
        ""
    )
    foreach ($s in $new) {
        Write-Host "[collect] session $($s.id) (created $($s.createdAt), phase $($s.phase), turns $($s.completedPlayerTurns))"
        $out = Join-Path $resultsDir "$($s.id).txt"
        node (Join-Path $repo "scripts\dongfang\turn-stats.mjs") $s.id | Out-File -FilePath $out -Encoding utf8
        Get-Content $out
        Write-Host "           -> saved: $out"
        $reportLines += @(
            "### $($s.id)",
            "",
            "- phase: $($s.phase) | completed player turns: $($s.completedPlayerTurns) | status: $($s.status)",
            "- save/resume: Owner marks ☐ after closing and reopening the browser and continuing this session",
            "",
            '```',
            (Get-Content $out -Raw),
            '```'
        )
    }
    $reportLines += @(
        "",
        "## Owner checklist (fill by hand)",
        "",
        "- [ ] prompt-hosted character creation worked (no covel form)",
        "- [ ] no visible covel framing / person / length / action-menu residue",
        "- [ ] prompt rules still held after 5+ free turns",
        "- [ ] save -> close -> reopen -> continue worked for every session above",
        "- [ ] overall experience not worse than the plain-Chat A path",
        ""
    )
    $reportLines | Out-File (Join-Path $resultsDir "report.md") -Encoding utf8
    Write-Host "[collect] report: $(Join-Path $resultsDir 'report.md')"
    @{ runId = $runId; memory = $Memory; runStart = $runStart; collectedAt = (Get-Date).ToUniversalTime().ToString("o");
       sessions = @($new | ForEach-Object { $_.id }) } |
        ConvertTo-Json | Out-File (Join-Path $resultsDir "meta.json") -Encoding utf8
}

function Get-StorySlotSummary {
    $toml = Join-Path $repo "llm.toml"
    if (Test-Path $toml) {
        $m = Select-String -Path $toml -Pattern "^\s*model\s*=\s*""([^""]+)""" | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    return "(no llm.toml - built-in default or browser Settings UI override)"
}

if ($AutoQuit) {
    Collect-Sessions
} else {
    while ($true) {
        Read-Host "Press Enter to collect stats now (or type q to finish)"
        Collect-Sessions
        $again = Read-Host "Collect again after more play? Enter=collect again, q=stop services and finish"
        if ($again -eq "q") { break }
    }
}

# ── stop dev services ───────────────────────────────────────────
foreach ($p in $ports) {
    $pid2 = Get-PortPid $p
    if ($pid2) {
        $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2").CommandLine
        if ($cmdline -and $cmdline -match "covel-spike") {
            Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue
        }
    }
}
if ($dev -and !$dev.HasExited) { Stop-Process -Id $dev.Id -Force -ErrorAction SilentlyContinue }
Write-Host "[done] results in: $resultsDir"
Write-Host "[done] remember to fill the Gate report template (docs\dongfang\GATE_A_SPIKE.md)."
