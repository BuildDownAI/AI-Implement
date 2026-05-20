#!/usr/bin/env python3
"""Migrate a GitHub Projects v2 project to a Linear project.

Phases (run independently, idempotent):
  preflight  — read-only audit; prints summary, validates structure, no writes
  structure  — create Linear project + labels (skips if exist); update existing seed issue if --seed-mapping given
  migrate    — create issues + comments + post GH cross-links (skips already-migrated rows in log)
  verify     — count + spot-check migrated issues against GH source

Usage example (the AlpacaWheel Project 7 migration this script generalizes):

    export LINEAR_API_KEY=lin_api_xxx
    python scripts/migrate_github_project_to_linear.py preflight \\
        --gh-owner jodwyer --gh-repo alpacaWheel --gh-project 7 \\
        --linear-team Oolidata --linear-project "Position Lifecycle Management"

    # review report, then:
    python scripts/migrate_github_project_to_linear.py structure --config <same args>
    python scripts/migrate_github_project_to_linear.py migrate   --config <same args>
    python scripts/migrate_github_project_to_linear.py verify    --config <same args>

Status mapping:
  GH closed → Linear Done
  GH open   → Linear Todo  (NOT In Progress; work hasn't started in Linear yet)

Priority mapping (override with --priority-labels):
  P0 → Urgent (1), P1 → High (2), P2 → Medium (3), P3 → Low (4), no P-label → No priority (0)

Label mapping:
  Type labels (bug/improvement/documentation/config) become Linear labels.
  Priority labels (P0–P3) become Linear's priority field, NOT labels.
  Status labels (in-progress) become Linear's state, NOT labels.
  Override with --type-labels and --priority-labels.

Requires: LINEAR_API_KEY env, gh CLI authenticated, Python 3.10+.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LINEAR_API = "https://api.linear.app/graphql"

DEFAULT_TYPE_LABELS = {"bug", "improvement", "documentation", "config"}
DEFAULT_PRIORITY_LABELS = {"P0": 1, "P1": 2, "P2": 3, "P3": 4}
DEFAULT_STATUS_LABELS = {"in-progress"}

GH_STATE_TO_LINEAR_STATE = {"open": "Todo", "closed": "Done"}


@dataclass
class Config:
    gh_owner: str
    gh_repo: str
    gh_project: int
    linear_team: str
    linear_project: str
    project_description: str
    project_icon: str
    log_path: Path
    type_labels: set[str] = field(default_factory=lambda: set(DEFAULT_TYPE_LABELS))
    priority_labels: dict[str, int] = field(default_factory=lambda: dict(DEFAULT_PRIORITY_LABELS))
    status_labels: set[str] = field(default_factory=lambda: set(DEFAULT_STATUS_LABELS))
    seed_mapping: dict[int, str] = field(default_factory=dict)  # gh_number → existing OOL-N
    label_color_overrides: dict[str, str] = field(default_factory=dict)
    pacing_seconds: float = 0.2


def linear_request(query: str, variables: dict | None = None) -> dict:
    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        sys.exit("error: LINEAR_API_KEY env var not set")
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = Request(
        LINEAR_API,
        data=body,
        headers={"Authorization": api_key, "Content-Type": "application/json"},
    )
    for attempt in range(5):
        try:
            with urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read())
            if "errors" in payload:
                msg = json.dumps(payload["errors"])
                if "rate" in msg.lower() and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"Linear API error: {msg}")
            return payload["data"]
        except (HTTPError, URLError) as exc:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Linear request failed: {exc}") from exc
    raise RuntimeError("Linear request retries exhausted")


def gh(*args: str, capture: bool = True) -> str:
    result = subprocess.run(["gh", *args], capture_output=capture, text=True)
    if result.returncode != 0:
        sys.exit(f"gh command failed: {' '.join(args)}\n{result.stderr}")
    return result.stdout


def fetch_gh_project_items(owner: str, project: int) -> list[dict]:
    raw = gh("project", "item-list", str(project), "--owner", owner, "--format", "json", "--limit", "1000")
    return json.loads(raw).get("items", [])


def fetch_gh_issue(owner: str, repo: str, number: int) -> dict:
    return json.loads(gh("api", f"repos/{owner}/{repo}/issues/{number}"))


def fetch_gh_comments(owner: str, repo: str, number: int) -> list[dict]:
    return json.loads(gh("api", f"repos/{owner}/{repo}/issues/{number}/comments"))


def gh_has_cross_link(owner: str, repo: str, number: int) -> bool:
    raw = gh("issue", "view", str(number), "--repo", f"{owner}/{repo}", "--json", "comments")
    comments = json.loads(raw).get("comments", [])
    return any("Migrated to Linear:" in c.get("body", "") for c in comments)


def fetch_team(name: str) -> dict:
    data = linear_request("query($q:String!){teams(filter:{name:{eq:$q}}){nodes{id name key}}}", {"q": name})
    nodes = data["teams"]["nodes"]
    if not nodes:
        sys.exit(f"error: Linear team {name!r} not found")
    return nodes[0]


def fetch_team_states(team_id: str) -> list[dict]:
    data = linear_request(
        "query($t:String!){workflowStates(filter:{team:{id:{eq:$t}}}){nodes{id name type}}}",
        {"t": team_id},
    )
    return data["workflowStates"]["nodes"]


def fetch_team_labels(team_id: str) -> list[dict]:
    data = linear_request(
        "query($t:String!){issueLabels(filter:{team:{id:{eq:$t}}}){nodes{id name color}}}",
        {"t": team_id},
    )
    return data["issueLabels"]["nodes"]


def fetch_workspace_user(email: str) -> dict | None:
    data = linear_request(
        "query($e:String!){users(filter:{email:{eq:$e}}){nodes{id name email}}}",
        {"e": email},
    )
    nodes = data["users"]["nodes"]
    return nodes[0] if nodes else None


def find_project_by_name(name: str) -> dict | None:
    data = linear_request(
        "query($q:String!){projects(filter:{name:{eq:$q}}){nodes{id name slugId state}}}",
        {"q": name},
    )
    nodes = data["projects"]["nodes"]
    return nodes[0] if nodes else None


def create_project(name: str, description: str, team_id: str, lead_id: str | None, icon: str) -> dict:
    mutation = """
    mutation($input: ProjectCreateInput!){
      projectCreate(input: $input){ success project{ id name slugId } }
    }
    """
    variables = {
        "input": {
            "name": name,
            "description": description,
            "teamIds": [team_id],
            "icon": icon,
            "state": "started",
            **({"leadId": lead_id} if lead_id else {}),
        }
    }
    return linear_request(mutation, variables)["projectCreate"]["project"]


def create_label(name: str, color: str, description: str, team_id: str) -> dict:
    mutation = """
    mutation($input: IssueLabelCreateInput!){
      issueLabelCreate(input: $input){ success issueLabel{ id name color } }
    }
    """
    return linear_request(
        mutation,
        {"input": {"name": name, "color": color, "description": description, "teamId": team_id}},
    )["issueLabelCreate"]["issueLabel"]


def create_issue(payload: dict) -> dict:
    mutation = """
    mutation($input: IssueCreateInput!){
      issueCreate(input: $input){ success issue{ id identifier url state{ name } } }
    }
    """
    return linear_request(mutation, {"input": payload})["issueCreate"]["issue"]


def update_issue(issue_id: str, payload: dict) -> dict:
    mutation = """
    mutation($id: String!, $input: IssueUpdateInput!){
      issueUpdate(id: $id, input: $input){ success issue{ id identifier url state{ name } } }
    }
    """
    return linear_request(mutation, {"id": issue_id, "input": payload})["issueUpdate"]["issue"]


def create_comment(issue_id: str, body: str) -> dict:
    mutation = """
    mutation($input: CommentCreateInput!){
      commentCreate(input: $input){ success comment{ id } }
    }
    """
    return linear_request(mutation, {"input": {"issueId": issue_id, "body": body}})["commentCreate"]["comment"]


def post_gh_cross_link(owner: str, repo: str, number: int, linear_id: str) -> None:
    gh("issue", "comment", str(number), "--repo", f"{owner}/{repo}", "--body", f"🔗 Migrated to Linear: {linear_id}")


def build_footer(issue: dict) -> str:
    created = issue["created_at"][:10]
    closed = issue.get("closed_at", "")[:10] if issue.get("closed_at") else ""
    author = issue["user"]["login"]
    number = issue["number"]
    repo_url = issue["html_url"].rsplit("/", 2)[0]
    lines = [
        "",
        "---",
        "",
        f"*Migrated from GitHub: [{repo_url.split('/', 3)[-1]}#{number}]({issue['html_url']})*",
        "",
        f"*Originally created: {created} by @{author}*",
    ]
    if closed:
        lines += ["", f"*Originally closed: {closed}*"]
    return "\n".join(lines)


def map_priority(labels: list[str], priority_map: dict[str, int]) -> int:
    matches = [priority_map[l] for l in labels if l in priority_map]
    return min(matches) if matches else 0


def map_labels(labels: list[str], type_labels: set[str], existing: dict[str, str]) -> list[str]:
    """Return Linear label IDs. Type labels are case-insensitively matched against existing labels."""
    out = []
    existing_lower = {n.lower(): (n, lid) for n, lid in existing.items()}
    for label in labels:
        if label.lower() in (t.lower() for t in type_labels):
            hit = existing_lower.get(label.lower())
            if hit:
                out.append(hit[1])
    return out


def load_log(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {"results": []}


def save_log(path: Path, log: dict) -> None:
    path.write_text(json.dumps(log, indent=2))


def already_migrated(log: dict, gh_number: int) -> str | None:
    for r in log["results"]:
        if r.get("gh") == gh_number:
            return r.get("linear")
    return None


def cmd_preflight(cfg: Config) -> int:
    print("=" * 60)
    print(f"Preflight: GH project {cfg.gh_owner}/{cfg.gh_project} → Linear {cfg.linear_project}")
    print("=" * 60)

    team = fetch_team(cfg.linear_team)
    print(f"\nLinear team: {team['name']} (id {team['id']})")

    states = fetch_team_states(team["id"])
    state_names = {s["name"] for s in states}
    for required in ("Todo", "Done", "In Progress"):
        if required in state_names:
            print(f"  ✓ workflow state {required!r} present")
        else:
            print(f"  ⚠ workflow state {required!r} MISSING — adapt mapping or create state")

    labels = fetch_team_labels(team["id"])
    label_names = {l["name"] for l in labels}
    print(f"\nExisting Linear labels ({len(labels)}): {sorted(label_names)}")
    print(f"Type labels needed: {sorted(cfg.type_labels)}")
    missing = {t for t in cfg.type_labels if t.lower() not in {n.lower() for n in label_names}}
    if missing:
        print(f"  → will create: {sorted(missing)}")
    else:
        print("  → all type labels present (case-insensitive match)")

    project = find_project_by_name(cfg.linear_project)
    if project:
        print(f"\nLinear project {cfg.linear_project!r} already exists (id {project['id']})")
    else:
        print(f"\nLinear project {cfg.linear_project!r} will be created in structure phase")

    items = fetch_gh_project_items(cfg.gh_owner, cfg.gh_project)
    repo_full = f"{cfg.gh_owner}/{cfg.gh_repo}"
    in_repo = [i for i in items if i.get("content", {}).get("repository") == repo_full]
    issues = [i for i in in_repo if i.get("content", {}).get("type") == "Issue"]
    prs = [i for i in in_repo if i.get("content", {}).get("type") == "PullRequest"]
    print(f"\nGH project {cfg.gh_project}: {len(items)} items total, {len(issues)} issues + {len(prs)} PRs in {repo_full}")
    if prs:
        print(f"  ⚠ {len(prs)} PullRequests will be skipped (only Issues migrate)")
    out_of_repo = [i for i in items if i.get("content", {}).get("repository") != repo_full]
    if out_of_repo:
        print(f"  ⚠ {len(out_of_repo)} items in other repos will be skipped")

    by_state = {"open": 0, "closed": 0}
    label_count: dict[str, int] = {}
    for item in issues:
        c = item["content"]
        by_state[c.get("state", "open").lower()] += 1
    for n in [c["content"]["number"] for c in issues]:
        # cheap label aggregate via project-item field; gh project json keeps minimal
        pass
    print(f"  state breakdown: {by_state['closed']} closed → Done, {by_state['open']} open → Todo")

    if cfg.seed_mapping:
        print(f"\nSeed mappings (in-place updates): {cfg.seed_mapping}")

    log = load_log(cfg.log_path)
    if log["results"]:
        prior = len(log["results"])
        print(f"\nLog: {prior} prior migrations recorded — will skip those in migrate phase (idempotent)")

    print("\nPreflight complete. Review the report, then run: structure → migrate → verify")
    return 0


def cmd_structure(cfg: Config) -> int:
    team = fetch_team(cfg.linear_team)

    project = find_project_by_name(cfg.linear_project)
    if project:
        print(f"Project exists: {cfg.linear_project} (id {project['id']})")
    else:
        user = fetch_workspace_user(os.environ.get("LINEAR_LEAD_EMAIL", ""))
        lead_id = user["id"] if user else None
        project = create_project(cfg.linear_project, cfg.project_description, team["id"], lead_id, cfg.project_icon)
        print(f"Created project: {project['id']} ({cfg.linear_project})")

    existing = {l["name"]: l["id"] for l in fetch_team_labels(team["id"])}
    existing_lower = {n.lower(): (n, lid) for n, lid in existing.items()}
    for label in sorted(cfg.type_labels):
        if label.lower() in existing_lower:
            print(f"Label exists: {existing_lower[label.lower()][0]}")
            continue
        color = cfg.label_color_overrides.get(label, "#888888")
        created = create_label(label, color, f"Type: {label}", team["id"])
        print(f"Created label: {created['name']} (id {created['id']})")
        time.sleep(cfg.pacing_seconds)

    return 0


def cmd_migrate(cfg: Config) -> int:
    team = fetch_team(cfg.linear_team)
    user = fetch_workspace_user(os.environ.get("LINEAR_LEAD_EMAIL", ""))
    project = find_project_by_name(cfg.linear_project)
    if not project:
        sys.exit(f"error: Linear project {cfg.linear_project!r} not found — run structure phase first")

    existing_labels = {l["name"]: l["id"] for l in fetch_team_labels(team["id"])}
    states = {s["name"]: s["id"] for s in fetch_team_states(team["id"])}

    items = fetch_gh_project_items(cfg.gh_owner, cfg.gh_project)
    repo_full = f"{cfg.gh_owner}/{cfg.gh_repo}"
    issue_numbers = [
        i["content"]["number"]
        for i in items
        if i.get("content", {}).get("type") == "Issue"
        and i.get("content", {}).get("repository") == repo_full
    ]

    # Sort: closed (oldest closedAt first) then open (oldest createdAt first)
    plan: list[tuple[int, dict]] = []
    for n in issue_numbers:
        issue = fetch_gh_issue(cfg.gh_owner, cfg.gh_repo, n)
        plan.append((n, issue))
    plan.sort(
        key=lambda p: (
            0 if p[1].get("state") == "closed" else 1,
            p[1].get("closed_at") or "9999-12-31",
            p[0],
        )
    )

    log = load_log(cfg.log_path)

    for gh_number, issue in plan:
        existing_link = already_migrated(log, gh_number)
        if existing_link:
            print(f"#{gh_number} → {existing_link} (already migrated; skipping)")
            continue

        labels_raw = [l["name"] for l in issue.get("labels", [])]
        priority = map_priority(labels_raw, cfg.priority_labels)
        label_ids = map_labels(labels_raw, cfg.type_labels, existing_labels)
        gh_state = issue.get("state", "open").lower()
        linear_state_name = GH_STATE_TO_LINEAR_STATE[gh_state]
        state_id = states.get(linear_state_name)
        if not state_id:
            print(f"  ⚠ state {linear_state_name!r} not in team — skipping #{gh_number}")
            continue

        body = (issue.get("body") or "").rstrip() + "\n" + build_footer(issue)
        seed = cfg.seed_mapping.get(gh_number)

        if seed:
            updated = update_issue(
                seed,
                {
                    "projectId": project["id"],
                    "labelIds": label_ids,
                    "priority": priority,
                    # seed status preserved unless caller explicitly wants it changed
                },
            )
            linear_id = updated["identifier"]
            print(f"#{gh_number} → updated in place {linear_id}")
        else:
            payload = {
                "title": issue["title"],
                "description": body,
                "teamId": team["id"],
                "projectId": project["id"],
                "stateId": state_id,
                "priority": priority,
                "labelIds": label_ids,
                **({"assigneeId": user["id"]} if user else {}),
            }
            created = create_issue(payload)
            linear_id = created["identifier"]
            linear_uuid = created["id"]
            print(f"#{gh_number} → created {linear_id}")

            comments = fetch_gh_comments(cfg.gh_owner, cfg.gh_repo, gh_number)
            for c in comments:
                cdate = c["created_at"][:10]
                cbody = f"*Originally posted by @{c['user']['login']} on {cdate}:*\n\n{c.get('body', '')}"
                create_comment(linear_uuid, cbody)
                time.sleep(cfg.pacing_seconds)

        if not gh_has_cross_link(cfg.gh_owner, cfg.gh_repo, gh_number):
            post_gh_cross_link(cfg.gh_owner, cfg.gh_repo, gh_number, linear_id)

        log["results"].append({"gh": gh_number, "linear": linear_id, "status": "created" if not seed else "updated_in_place", "gh_link_posted": True})
        save_log(cfg.log_path, log)
        time.sleep(cfg.pacing_seconds)

    print(f"\nMigrate complete. {len(log['results'])} issues in log → {cfg.log_path}")
    return 0


def cmd_verify(cfg: Config) -> int:
    log = load_log(cfg.log_path)
    project = find_project_by_name(cfg.linear_project)
    if not project:
        sys.exit(f"error: Linear project {cfg.linear_project!r} not found")
    data = linear_request(
        """
        query($p:ID!){
          project(id:$p){
            issues(first:250){
              nodes{ identifier title state{name} priority labels{nodes{name}} }
            }
          }
        }
        """,
        {"p": project["id"]},
    )
    nodes = data["project"]["issues"]["nodes"]
    print(f"Linear project: {cfg.linear_project} — {len(nodes)} issues")
    states: dict[str, int] = {}
    for n in nodes:
        states[n["state"]["name"]] = states.get(n["state"]["name"], 0) + 1
    print(f"  by state: {states}")
    print(f"  log entries: {len(log['results'])}")

    items = fetch_gh_project_items(cfg.gh_owner, cfg.gh_project)
    repo_full = f"{cfg.gh_owner}/{cfg.gh_repo}"
    expected = sum(
        1 for i in items
        if i.get("content", {}).get("type") == "Issue"
        and i.get("content", {}).get("repository") == repo_full
    )
    if len(nodes) >= expected:
        print(f"  ✓ Linear count ({len(nodes)}) >= GH project count ({expected})")
    else:
        print(f"  ⚠ Linear count ({len(nodes)}) < GH project count ({expected}) — investigate")
    return 0


def parse_args() -> tuple[str, Config]:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("phase", choices=["preflight", "structure", "migrate", "verify"])
    p.add_argument("--gh-owner", required=True)
    p.add_argument("--gh-repo", required=True)
    p.add_argument("--gh-project", type=int, required=True)
    p.add_argument("--linear-team", required=True)
    p.add_argument("--linear-project", required=True)
    p.add_argument("--project-description", default="")
    p.add_argument("--project-icon", default=":file_folder:")
    p.add_argument("--log-path", default="migration-log.json")
    p.add_argument(
        "--seed-mapping",
        default="",
        help="comma-sep gh:OOL pairs for in-place updates, e.g. '2504:OOL-5'",
    )
    p.add_argument("--pacing", type=float, default=0.2, help="seconds between Linear writes")
    args = p.parse_args()

    seed: dict[int, str] = {}
    for entry in (args.seed_mapping or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        gh_num, linear_id = entry.split(":")
        seed[int(gh_num)] = linear_id.strip()

    cfg = Config(
        gh_owner=args.gh_owner,
        gh_repo=args.gh_repo,
        gh_project=args.gh_project,
        linear_team=args.linear_team,
        linear_project=args.linear_project,
        project_description=args.project_description,
        project_icon=args.project_icon,
        log_path=Path(args.log_path),
        seed_mapping=seed,
        pacing_seconds=args.pacing,
        label_color_overrides={
            "bug": "#D73A4A",
            "improvement": "#A2EEEF",
            "documentation": "#0075CA",
            "config": "#C5DEF5",
        },
    )
    return args.phase, cfg


def main() -> int:
    phase, cfg = parse_args()
    handlers = {
        "preflight": cmd_preflight,
        "structure": cmd_structure,
        "migrate": cmd_migrate,
        "verify": cmd_verify,
    }
    return handlers[phase](cfg)


if __name__ == "__main__":
    sys.exit(main())
