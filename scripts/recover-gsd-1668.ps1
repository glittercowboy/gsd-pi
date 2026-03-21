# recover-gsd-1668.ps1 — Recovery script for issue #1668 (Windows)
#
# GSD v2.39.x deleted the milestone branch and worktree directory when a
# merge failed due to the repo using `master` as its default branch (not
# `main`). The commits were never merged — they are orphaned in the git
# object store and can be recovered via git reflog or git fsck.
#
# This script:
#   1. Searches git reflog for the deleted milestone branch (fastest path)
#   2. Falls back to git fsck --unreachable to find orphaned commits
#   3. Ranks candidates by recency and GSD commit message patterns
#   4. Creates a recovery branch at the identified commit
#   5. Reports what was found and how to complete the merge manually
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\recover-gsd-1668.ps1 [-MilestoneId <ID>] [-DryRun] [-Auto]
#
# Options:
#   -MilestoneId <ID>   GSD milestone ID (e.g. M001-g2nalq).
#   -DryRun             Show what would be done without making any changes.
#   -Auto               Pick best candidate automatically (no prompts).
#
# Requirements: git >= 2.23, PowerShell >= 5.1, Git for Windows
#
# Affected versions: GSD 2.39.x
# Fixed in: GSD 2.40.1 (PR #1669)

[CmdletBinding()]
param(
    [string]$MilestoneId = "",
    [switch]$DryRun,
    [switch]$Auto
)

$ErrorActionPreference = 'Stop'

# ── Helpers ───────────────────────────────────────────────────────────────────

function Info    { param($msg) Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Ok      { param($msg) Write-Host "[ok]    $msg" -ForegroundColor Green }
function Warn    { param($msg) Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Err     { param($msg) Write-Host "[error] $msg" -ForegroundColor Red }
function Section { param($msg) Write-Host "`n$msg" -ForegroundColor White }
function Dim     { param($msg) Write-Host "        $msg" -ForegroundColor DarkGray }

function Run {
    param($cmd)
    if ($DryRun) {
        Write-Host "  (dry-run) $cmd" -ForegroundColor Yellow
    } else {
        Invoke-Expression $cmd
    }
}

function Git {
    param([string[]]$args)
    $output = & git @args 2>&1
    if ($LASTEXITCODE -ne 0) { return "" }
    return $output -join "`n"
}

function Die {
    param($msg)
    Err $msg
    exit 1
}

# ── Preflight ─────────────────────────────────────────────────────────────────

Section "── Preflight ───────────────────────────────────────────────────────────"

$gitDir = & git rev-parse --git-dir 2>&1
if ($LASTEXITCODE -ne 0) {
    Die "Not inside a git repository. Run this from your project root."
}

$repoRoot = (& git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot
Info "Repo root: $repoRoot"

if ($DryRun) { Warn "DRY-RUN mode — no changes will be made." }

# ── Step 1: Check live milestone branches ────────────────────────────────────

Section "── Step 1: Verify milestone branch is missing ───────────────────────────"

$branchPattern = if ($MilestoneId) { "milestone/$MilestoneId" } else { "milestone/" }
$liveBranches = & git branch 2>/dev/null | Where-Object { $_ -match [regex]::Escape($branchPattern) } | ForEach-Object { $_.Trim().TrimStart('* ') }

if ($liveBranches) {
    Ok "Found live milestone branch(es):"
    $liveBranches | ForEach-Object { Write-Host "  $_" }
    Warn "The branch still exists — are you sure it was lost?"
    Write-Host "  git checkout $($liveBranches[0])"
    if (-not $MilestoneId) { exit 0 }
}

if ($MilestoneId -and -not $liveBranches) {
    Info "Confirmed: milestone/$MilestoneId branch is gone."
} elseif (-not $MilestoneId) {
    Info "No live milestone/ branches found — scanning for orphaned commits."
}

# ── Step 2: Search git reflog ─────────────────────────────────────────────────

Section "── Step 2: Search git reflog for deleted branch ────────────────────────"

$reflogFoundSha = ""
$reflogFoundBranch = ""

if ($MilestoneId) {
    $reflogPath = Join-Path $repoRoot ".git\logs\refs\heads\milestone\$MilestoneId"
    if (Test-Path $reflogPath) {
        $lines = Get-Content $reflogPath
        if ($lines) {
            $lastLine = $lines[-1]
            $reflogFoundSha = ($lastLine -split '\s+')[1]
            $reflogFoundBranch = "milestone/$MilestoneId"
            Ok "Reflog entry found for milestone/$MilestoneId — commit: $($reflogFoundSha.Substring(0,12))"
        }
    } else {
        Info "No reflog file at .git\logs\refs\heads\milestone\$MilestoneId"
    }
}

if (-not $reflogFoundSha) {
    Info "Scanning git reflog for milestone/ commits..."
    $reflogAll = & git reflog --all --format="%H %gs" 2>/dev/null | Where-Object { $_ -match "milestone/" } | Select-Object -First 20
    if ($reflogAll) {
        Info "Found milestone-related reflog entries:"
        $reflogAll | ForEach-Object { Dim $_ }
        $match = if ($MilestoneId) {
            $reflogAll | Where-Object { $_ -match "milestone/$([regex]::Escape($MilestoneId))" } | Select-Object -First 1
        } else {
            $reflogAll | Select-Object -First 1
        }
        if ($match) {
            $reflogFoundSha = ($match -split '\s+')[0]
            if ($match -match 'milestone/(\S+)') { $reflogFoundBranch = "milestone/$($Matches[1])" }
            else { $reflogFoundBranch = "milestone/unknown" }
        }
    } else {
        Info "No milestone/ entries in reflog."
    }
}

# ── Step 3: Fall back to git fsck ─────────────────────────────────────────────

Section "── Step 3: Scan for orphaned (unreachable) commits ───────────────────"

$sortedCandidates = @()

if (-not $reflogFoundSha) {
    Info "Running git fsck --unreachable (this may take a moment)..."

    $fsckOutput = & git fsck --unreachable --no-reflogs 2>/dev/null | Where-Object { $_ -match '^unreachable commit' }
    if (-not $fsckOutput) {
        $fsckOutput = & git fsck --unreachable 2>/dev/null | Where-Object { $_ -match '^unreachable commit' }
    }

    $unreachableCommits = $fsckOutput | ForEach-Object { ($_ -split '\s+')[2] } | Where-Object { $_ }

    $total = @($unreachableCommits).Count
    Info "Found $total unreachable commit object(s)."

    if ($total -eq 0) {
        Err "No unreachable commits found."
        Write-Host ""
        Write-Host "This means one of:"
        Write-Host "  1. git gc has already pruned the objects (default: 14 days)"
        Write-Host "  2. The commits were never written to the object store"
        Write-Host "  3. The wrong repository is being scanned"
        exit 1
    }

    $cutoff = (Get-Date).AddDays(-30).ToUnixTimeSeconds()

    $candidates = @()
    foreach ($sha in $unreachableCommits) {
        if (-not $sha) { continue }
        $commitDate = [long](& git show -s --format="%ct" $sha 2>/dev/null)
        if (-not $commitDate -or $commitDate -lt $cutoff) { continue }

        $commitMsg  = (& git show -s --format="%s" $sha 2>/dev/null) -join ""
        $commitBody = (& git show -s --format="%b" $sha 2>/dev/null) -join " "
        $commitDateHr = (& git show -s --format="%ci" $sha 2>/dev/null) -join ""

        $score = 0
        if ($MilestoneId -and ($commitMsg + $commitBody) -match [regex]::Escape($MilestoneId)) { $score += 100 }
        if ($commitMsg -match '^feat\([A-Z][0-9]+') { $score += 50 }
        if (($commitMsg + $commitBody) -match 'milestone/|complete-milestone|GSD|slice') { $score += 20 }

        $weekAgo = (Get-Date).AddDays(-7).ToUnixTimeSeconds()
        if ($commitDate -gt $weekAgo) { $score += 10 }

        $fileCount = (& git show --stat --format="" $sha 2>/dev/null | Select-Object -Last 1) -replace '.*?(\d+) file.*','$1'

        $candidates += [PSCustomObject]@{
            SHA        = $sha
            Score      = $score
            Message    = $commitMsg
            Date       = $commitDateHr
            FileCount  = $fileCount
        }
    }

    if ($candidates.Count -eq 0) {
        Err "No recent unreachable commits found within the last 30 days."
        Write-Host "Objects may have been pruned by git gc."
        exit 1
    }

    $sortedCandidates = $candidates | Sort-Object -Property Score -Descending | Select-Object -First 10

    Info "Top candidates (scored by recency and GSD message patterns):"
    Write-Host ""
    $num = 1
    foreach ($c in $sortedCandidates) {
        Write-Host "  $num) $($c.SHA.Substring(0,12))  $($c.Message)" -ForegroundColor Green
        Dim "$($c.Date) — $($c.FileCount) file(s)"
        $num++
    }
    Write-Host ""
}

# ── Step 4: Select recovery commit ───────────────────────────────────────────

Section "── Step 4: Select recovery commit ──────────────────────────────────────"

$recoverySha = ""
$recoverySource = ""

if ($reflogFoundSha) {
    $recoverySha = $reflogFoundSha
    $recoverySource = "reflog ($reflogFoundBranch)"
    Info "Using reflog candidate: $($recoverySha.Substring(0,12))"
    Dim (& git show -s --format="%s %ci" $recoverySha 2>/dev/null)

} elseif ($sortedCandidates.Count -eq 1 -or $Auto) {
    $recoverySha = $sortedCandidates[0].SHA
    $recoverySource = "fsck (auto-selected)"
    Info "Auto-selecting best candidate: $($recoverySha.Substring(0,12))"

} else {
    $selection = Read-Host "Select a candidate to recover [1-$($sortedCandidates.Count), or q to quit]"
    if ($selection -eq 'q') { Info "Aborted."; exit 0 }
    $selIdx = [int]$selection - 1
    if ($selIdx -lt 0 -or $selIdx -ge $sortedCandidates.Count) { Die "Invalid selection: $selection" }
    $recoverySha = $sortedCandidates[$selIdx].SHA
    $recoverySource = "fsck (user-selected #$selection)"
}

if (-not $recoverySha) { Die "Could not determine a recovery commit." }

Ok "Recovery commit: $($recoverySha.Substring(0,16))  (source: $recoverySource)"
Write-Host ""
Info "Commit details:"
& git show -s --format="  Message:   %s`n  Author:    %an <%ae>`n  Date:      %ci`n  Full SHA:  %H" $recoverySha
Write-Host ""
Info "Files at this commit (first 30):"
& git show --stat --format="" $recoverySha 2>/dev/null | Select-Object -First 30
Write-Host ""

# ── Step 5: Create recovery branch ───────────────────────────────────────────

Section "── Step 5: Create recovery branch ──────────────────────────────────────"

$recoveryBranch = if ($MilestoneId) {
    "recovery/1668/$MilestoneId"
} elseif ($reflogFoundBranch) {
    "recovery/1668/$($reflogFoundBranch -replace '/','-')"
} else {
    "recovery/1668/commit-$($recoverySha.Substring(0,8))"
}

$branchExists = & git show-ref --verify --quiet "refs/heads/$recoveryBranch" 2>/dev/null; $exists = $LASTEXITCODE -eq 0
if ($exists) {
    Warn "Branch $recoveryBranch already exists."
    if (-not $Auto) {
        $answer = Read-Host "Overwrite it? [y/N]"
        if ($answer -notin @('y','Y')) { Info "Aborted."; exit 0 }
    }
    Run "git branch -D `"$recoveryBranch`""
}

Run "git branch `"$recoveryBranch`" `"$recoverySha`""

if (-not $DryRun) {
    Ok "Recovery branch created: $recoveryBranch"
} else {
    Ok "(dry-run) Would create branch: $recoveryBranch -> $($recoverySha.Substring(0,12))"
}

# ── Step 6: Verify ────────────────────────────────────────────────────────────

if (-not $DryRun) {
    Section "── Step 6: Verify recovery branch ──────────────────────────────────────"
    $fileList = & git ls-tree -r --name-only $recoveryBranch 2>/dev/null | Where-Object { $_ -notmatch '^\.gsd/' }
    $fileCount = @($fileList).Count
    Info "Files recoverable (excluding .gsd/ state files): $fileCount"
    $fileList | Select-Object -First 30 | ForEach-Object { Write-Host "  $_" }
    if ($fileCount -gt 30) { Dim "  ... and $($fileCount - 30) more" }
}

# ── Summary ───────────────────────────────────────────────────────────────────

Section "── Recovery Summary ─────────────────────────────────────────────────────"

if ($DryRun) {
    Write-Host "Dry-run complete. Re-run without -DryRun to apply." -ForegroundColor Yellow
    exit 0
}

$defaultBranch = (& git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null) -replace 'refs/remotes/origin/',''
if (-not $defaultBranch) { $defaultBranch = (& git branch --show-current) }

Write-Host "Recovery branch ready: " -NoNewline
Write-Host $recoveryBranch -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host ""
Write-Host "  1. Inspect the recovered files:"
Write-Host "     git checkout $recoveryBranch"
Write-Host "     dir"
Write-Host ""
Write-Host "  2. Verify your code is intact:"
Write-Host "     git log --oneline $recoveryBranch | head -20"
Write-Host ""
Write-Host "  3. Merge to your default branch ($defaultBranch):"
Write-Host "     git checkout $defaultBranch"
Write-Host "     git merge --squash $recoveryBranch"
Write-Host "     git commit -m `"feat: recover milestone from #1668`""
Write-Host ""
Write-Host "  4. Clean up after verifying:"
Write-Host "     git branch -D $recoveryBranch"
Write-Host ""
Write-Host "Note: update GSD to v2.40.1+ to prevent this from recurring." -ForegroundColor DarkGray
Write-Host "      PR: https://github.com/gsd-build/gsd-2/pull/1669" -ForegroundColor DarkGray
Write-Host ""
