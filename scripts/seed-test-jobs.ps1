# scripts/seed-test-jobs.ps1
# Pre-seeds dispatch_log with jobs spread across time for local filter testing.
# Usage: .\scripts\seed-test-jobs.ps1 [-DbPath .\data\dedup.sqlite]

param(
    [string]$DbPath = ".\data\dedup.sqlite"
)

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$h   = 3600000
$d   = 86400000

$jobs = @(
    # Last hour
    @{ offset = 10*60*1000;  id = "LIN-101"; title = "Fix login bug";           status = "completed"; mode = "github-actions"; phase = "implementation" }
    @{ offset = 30*60*1000;  id = "LIN-102"; title = "Add dark mode";           status = "running";   mode = "github-actions"; phase = "implementation" }
    # Last day (1-24 h ago)
    @{ offset = 3*$h;        id = "LIN-103"; title = "Refactor auth module";    status = "completed"; mode = "fly-machines";   phase = "implementation" }
    @{ offset = 8*$h;        id = "LIN-104"; title = "Update deps";             status = "failed";    mode = "github-actions"; phase = "implementation" }
    @{ offset = 20*$h;       id = "LIN-105"; title = "Add rate limiting";       status = "completed"; mode = "github-actions"; phase = "planning"        }
    # Last week (1-7 d ago)
    @{ offset = 2*$d;        id = "LIN-106"; title = "DB migration v3";         status = "completed"; mode = "fly-machines";   phase = "implementation" }
    @{ offset = 4*$d;        id = "LIN-107"; title = "CI pipeline fix";         status = "timed_out"; mode = "github-actions"; phase = "implementation" }
    @{ offset = 6*$d;        id = "LIN-108"; title = "Resize images on upload"; status = "completed"; mode = "github-actions"; phase = "implementation" }
    # Older (> 7 d)
    @{ offset = 10*$d;       id = "LIN-109"; title = "Initial scaffold";        status = "completed"; mode = "github-actions"; phase = "implementation" }
    @{ offset = 30*$d;       id = "LIN-110"; title = "Prototype spike";         status = "completed"; mode = "fly-machines";   phase = "implementation" }
)

$inserts = $jobs | ForEach-Object {
    $at  = $now - $_.offset
    "INSERT INTO dispatch_log (issue_id, issue_identifier, issue_title, team_key, repo, dispatched_at, status, execution_mode, phase, dispatch_number) VALUES ('$($_.id)', '$($_.id)', '$($_.title)', 'ENG', 'acme/backend', $at, '$($_.status)', '$($_.mode)', '$($_.phase)', 1);"
}

$sql = ($inserts -join "`n")

Write-Host "Seeding $($jobs.Count) jobs into $DbPath ..."
$sql | sqlite3 $DbPath
Write-Host "Done. Jobs span: last hour (2), last day (3), last week (3), older (2)."
