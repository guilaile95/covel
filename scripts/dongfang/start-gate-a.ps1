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

# ── 2. first-run LLM config (same model as your A path!) ────────
$llmToml = Join-Path $repo "llm.toml"
$envLlm = Join-Path $repo ".env.llm"
if (-not (Test-Path $llmToml) -or -not (Test-Path $envLlm)) {
    Write-Host ""
    Write-Host "=== First-time setup =========================================="
    Write-Host " Gate A requires the SAME model as your plain-Chat A path."
    Write-Host " 1. in llm.toml: set [covel.story] provider/model/baseUrl to that model"
    Write-Host "    (Gemini via Google AI Studio OpenAI-compat endpoint works;"
    Write-Host "     DeepSeek preset is already there as the default)"
    Write-Host " 2. in .env.llm: un-comment and fill the matching *_API_KEY line"
    Write-Host " Both files will open in Notepad now. Do NOT commit them."
    Write-Host "==============================================================="
    if (-not (Test-Path $llmToml)) { Copy-Item (Join-Path $repo "llm.toml.example") $llmToml }
    if (-not (Test-Path $envLlm)) { Copy-Item (Join-Path $repo ".env.llm.example") $envLlm }
    if ($AutoQuit) {
        Write-Host "[autoquit] first-run config files staged; fill them before a real run."
    } else {
        Start-Process notepad $llmToml
        Start-Process notepad $envLlm
        Read-Host "Save both files, then press Enter to continue"
    }
}

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
Start-Process "http://localhost:5173/"
Write-Host ""
Write-Host "==============================================================="
Write-Host " Browser is open. Play now:"
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
    foreach ($s in $new) {
        Write-Host "[collect] session $($s.id) (created $($s.createdAt), phase $($s.phase))"
        $out = Join-Path $resultsDir "$($s.id).txt"
        node (Join-Path $repo "scripts\dongfang\turn-stats.mjs") $s.id | Out-File -FilePath $out -Encoding utf8
        Get-Content $out
        Write-Host "           -> saved: $out"
    }
    @{ runId = $runId; memory = $Memory; runStart = $runStart; collectedAt = (Get-Date).ToUniversalTime().ToString("o");
       sessions = @($new | ForEach-Object { $_.id }) } |
        ConvertTo-Json | Out-File (Join-Path $resultsDir "meta.json") -Encoding utf8
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
