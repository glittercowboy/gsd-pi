#!/usr/bin/env -S uv --quiet run --active --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "typer>=0.21.0",
#   "PyGithub>=2.1.1",
# ]
# ///
"""GitHub Project Setup — multi-step project management automation.

Orchestrates: label creation, milestone management, project setup,
Projects V2 status updates, and backlog item issue import using the
PyGithub native library. Projects V2 GraphQL mutations use the gh CLI.

Authentication: reads GITHUB_TOKEN from environment.

Usage:
    github_project_setup.py setup    --repo OWNER/REPO [--project-title TITLE]
    github_project_setup.py labels   --repo OWNER/REPO [--force]
    github_project_setup.py milestone create --repo OWNER/REPO --title TITLE [--due YYYY-MM-DD]
    github_project_setup.py milestone list   --repo OWNER/REPO
    github_project_setup.py milestone start  --repo OWNER/REPO --number N [--dry-run]
    github_project_setup.py milestone close  --repo OWNER/REPO --number N [--dry-run]
    github_project_setup.py issue create     --repo OWNER/REPO --title TITLE [options]
    github_project_setup.py issue list       --repo OWNER/REPO [--priority p1] [--state open]
    github_project_setup.py project update-status --project-number N --issue-number N --status STATUS
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated

import typer
from github import Auth, Github, GithubException

if TYPE_CHECKING:
    from github.Issue import Issue
    from github.Label import Label
    from github.Milestone import Milestone
    from github.Repository import Repository

app = typer.Typer(help="GitHub Project management automation via PyGithub")
milestone_app = typer.Typer(help="Milestone operations")
issue_app = typer.Typer(help="Issue operations")
project_app = typer.Typer(help="GitHub Projects V2 operations")
app.add_typer(milestone_app, name="milestone")
app.add_typer(issue_app, name="issue")
app.add_typer(project_app, name="project")

DEFAULT_REPO = "Jamie-BitFlight/claude_skills"

# Standard label taxonomy
LABELS: list[dict[str, str]] = [
    # Priority
    {"name": "priority:p0", "color": "D73A4A", "description": "Critical — blocks work or production"},
    {"name": "priority:p1", "color": "E99695", "description": "High — should be done next"},
    {"name": "priority:p2", "color": "F9D0C4", "description": "Medium — do when P0/P1 are clear"},
    {"name": "priority:idea", "color": "BFD4F2", "description": "Unscoped — future consideration"},
    # Type
    {"name": "type:feature", "color": "0E8A16", "description": "New capability or skill"},
    {"name": "type:bug", "color": "B60205", "description": "Something is broken"},
    {"name": "type:refactor", "color": "5319E7", "description": "Internal improvement, no behavior change"},
    {"name": "type:docs", "color": "0075CA", "description": "Documentation only"},
    {"name": "type:chore", "color": "EDEDED", "description": "Maintenance, tooling, CI"},
    # Status (all 8 state-machine states + legacy needs-review)
    {"name": "status:needs-grooming", "color": "FEF2C0", "description": "Captured but not yet groomed"},
    {"name": "status:groomed", "color": "C2E0C6", "description": "Grooming complete, RT-ICA APPROVED"},
    {"name": "status:blocked", "color": "B60205", "description": "RT-ICA BLOCKED or AC verification FAIL"},
    {"name": "status:in-milestone", "color": "BFD4F2", "description": "Assigned to an active milestone"},
    {"name": "status:in-progress", "color": "1D76DB", "description": "Actively being worked on"},
    {"name": "status:done", "color": "0E8A16", "description": "Implementation complete, AC verified PASS"},
    {"name": "status:resolved", "color": "6B737B", "description": "Closed without full implementation"},
    {"name": "status:closed", "color": "EDEDED", "description": "Terminal — milestone archived"},
    # Legacy label retained for backwards compatibility — not part of state machine
    {"name": "status:needs-review", "color": "D876E3", "description": "Implementation done, needs review"},
]

PRIORITY_LABEL_MAP = {"P0": "priority:p0", "P1": "priority:p1", "P2": "priority:p2", "IDEAS": "priority:idea"}

VALID_STATUSES = ("Backlog", "Grooming", "In Progress", "In Review", "Done")

# Label-to-status mapping for milestone transitions
_LABEL_TO_PROJECT_STATUS = {
    "status:in-progress": "In Progress",
    "status:done": "Done",
    "status:needs-grooming": "Grooming",
    "status:needs-review": "In Review",
    "status:blocked": "Backlog",
}


def get_github() -> Github:
    """Return an authenticated Github client from GITHUB_TOKEN."""
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        typer.echo("ERROR: GITHUB_TOKEN environment variable not set", err=True)
        raise typer.Exit(1)
    return Github(auth=Auth.Token(token))


def get_repo(gh: Github, repo_slug: str) -> Repository:
    """Return a Repository object, exit on failure.

    Args:
        gh: Authenticated Github client.
        repo_slug: Repository identifier in ``owner/repo`` format.

    Returns:
        Repository object for the given slug.
    """
    try:
        return gh.get_repo(repo_slug)
    except GithubException as exc:
        typer.echo(f"ERROR: Cannot access repo '{repo_slug}': {exc}", err=True)
        raise typer.Exit(1) from exc


@app.command()
def labels(
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    force: Annotated[bool, typer.Option("--force")] = False,
) -> None:
    """Create standard label taxonomy. Skips labels that already exist unless --force."""
    gh = get_github()
    repository = get_repo(gh, repo)

    existing = {lbl.name: lbl for lbl in repository.get_labels()}
    created = updated = skipped = 0

    for spec in LABELS:
        name = spec["name"]
        if name in existing:
            if force:
                existing[name].edit(name=name, color=spec["color"], description=spec["description"])
                typer.echo(f"  updated: {name}")
                updated += 1
            else:
                typer.echo(f"  exists:  {name}  (--force to update)")
                skipped += 1
        else:
            repository.create_label(name=name, color=spec["color"], description=spec["description"])
            typer.echo(f"  created: {name}")
            created += 1

    typer.echo(f"\nLabels: {created} created, {updated} updated, {skipped} skipped")


@milestone_app.command("create")
def milestone_create(
    title: Annotated[str, typer.Option("--title")],
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    description: Annotated[str, typer.Option("--description")] = "",
    due: Annotated[str | None, typer.Option("--due", help="Due date YYYY-MM-DD")] = None,
) -> None:
    """Create a milestone."""
    gh = get_github()
    repository = get_repo(gh, repo)

    due_dt = datetime.strptime(due, "%Y-%m-%d").replace(tzinfo=UTC) if due else None
    if due_dt is not None and description:
        milestone = repository.create_milestone(title=title, description=description, due_on=due_dt)
    elif due_dt is not None:
        milestone = repository.create_milestone(title=title, due_on=due_dt)
    elif description:
        milestone = repository.create_milestone(title=title, description=description)
    else:
        milestone = repository.create_milestone(title=title)
    typer.echo(f"Created milestone #{milestone.number}: {milestone.title}")
    typer.echo(f"  URL: {milestone.html_url}")


@milestone_app.command("list")
def milestone_list(repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO) -> None:
    """List all open milestones."""
    gh = get_github()
    repository = get_repo(gh, repo)

    milestones = list(repository.get_milestones(state="all"))
    if not milestones:
        typer.echo("No milestones.")
        return
    for m in milestones:
        due = m.due_on.strftime("%Y-%m-%d") if m.due_on else "no due date"
        typer.echo(
            f"  #{m.number:3d}  [{m.state}]  {m.title}  ({m.open_issues} open, {m.closed_issues} closed)  due: {due}"
        )


@milestone_app.command("start")
def milestone_start(
    number: Annotated[int, typer.Option("--number", "-n", help="Milestone number")],
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
    project_number: Annotated[int, typer.Option("--project-number", "-p", help="Projects V2 number")] = 0,
    owner: Annotated[str, typer.Option("--owner", help="GitHub owner for Projects V2")] = "Jamie-BitFlight",
) -> None:
    """Transition open milestone issues from status:needs-grooming to status:in-progress.

    When --project-number is set, also updates the Projects V2 Status field
    to "In Progress" for each transitioned issue.
    """
    gh = get_github()
    repository = get_repo(gh, repo)
    milestone = _get_open_milestone(repository, number)

    if milestone.open_issues == 0:
        typer.echo(
            f"WARNING: Milestone #{number} '{milestone.title}' has no open issues. "
            "Add items first with /group-items-to-milestone."
        )
        raise typer.Exit(0)

    open_issues = list(repository.get_issues(milestone=milestone, state="open"))
    typer.echo(f"Milestone #{milestone.number}: {milestone.title}")
    typer.echo(f"  {milestone.open_issues} open issue(s) — transitioning labels:\n")

    for issue in open_issues:
        label_names = [lbl.name for lbl in issue.labels]
        typer.echo(f"  #{issue.number:4d}  {issue.title[:60]:<60}  [{', '.join(label_names)}]")

    if dry_run:
        typer.echo("\n[dry-run] No changes made.")
        if project_number:
            typer.echo("\nProjects V2 status updates (dry-run):")
            _bulk_update_project_status(owner, project_number, open_issues, "In Progress", dry_run=True)
        return

    in_progress_label = _ensure_label(repository, "status:in-progress", "1D76DB", "Actively being worked on")
    succeeded, skipped, failed = _transition_issues(open_issues, in_progress_label)

    # Update Projects V2 Status if project specified
    v2_succeeded = v2_failed = 0
    if project_number:
        typer.echo("\nUpdating Projects V2 Status → In Progress:")
        v2_succeeded, v2_failed = _bulk_update_project_status(owner, project_number, open_issues, "In Progress")

    typer.echo(
        f"\nMilestone #{milestone.number} '{milestone.title}' started.\n"
        f"  {succeeded} transitioned, {skipped} already in-progress, {failed} failed."
    )
    if project_number:
        typer.echo(f"  Projects V2: {v2_succeeded} updated, {v2_failed} failed.")
    typer.echo(
        f"\nWork on individual items:\n"
        f"  /work-backlog-item {{title}}\n"
        f"\nTrack progress:\n"
        f"  uv run .claude/skills/gh/scripts/github_project_setup.py issue list "
        f"--repo {repo}"
    )
    if failed:
        raise typer.Exit(1)


@milestone_app.command("close")
def milestone_close(
    number: Annotated[int, typer.Option("--number", "-n", help="Milestone number")],
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
    project_number: Annotated[int, typer.Option("--project-number", "-p", help="Projects V2 number")] = 0,
    owner: Annotated[str, typer.Option("--owner", help="GitHub owner for Projects V2")] = "Jamie-BitFlight",
) -> None:
    """Close a milestone: transition open issues to status:done and close the milestone.

    When --project-number is set, also updates the Projects V2 Status field
    to "Done" for each issue in the milestone (both open and already-closed).
    """
    gh = get_github()
    repository = get_repo(gh, repo)
    milestone = _get_open_milestone(repository, number)

    open_issues = list(repository.get_issues(milestone=milestone, state="open"))
    closed_issues = list(repository.get_issues(milestone=milestone, state="closed"))
    total = len(open_issues) + len(closed_issues)

    typer.echo(f"Milestone #{milestone.number}: {milestone.title}")
    typer.echo(f"  {len(closed_issues)} closed, {len(open_issues)} open\n")

    if open_issues:
        typer.echo("Open issues (will be transitioned to status:done):")
        for issue in open_issues:
            label_names = [lbl.name for lbl in issue.labels]
            typer.echo(f"  #{issue.number:4d}  {issue.title[:60]:<60}  [{', '.join(label_names)}]")
        typer.echo()

    if dry_run:
        typer.echo("[dry-run] No changes made.")
        if project_number:
            all_issues = open_issues + closed_issues
            typer.echo("\nProjects V2 status updates (dry-run):")
            _bulk_update_project_status(owner, project_number, all_issues, "Done", dry_run=True)
        return

    succeeded = skipped = failed = 0
    if open_issues:
        done_label = _ensure_label(repository, "status:done", "0E8A16", "Work complete, milestone closing")
        succeeded, skipped, failed = _transition_to_done(open_issues, done_label)

    # Close the milestone
    milestone.edit(title=milestone.title, state="closed")
    typer.echo(f"\nMilestone #{milestone.number} '{milestone.title}' closed.")
    if open_issues:
        typer.echo(f"  {succeeded} transitioned to status:done, {skipped} already done, {failed} failed.")
    typer.echo(f"  {len(closed_issues)}/{total} issues were closed before milestone close.")

    # Update Projects V2 Status for all issues in milestone
    v2_succeeded = v2_failed = 0
    if project_number:
        all_issues = open_issues + closed_issues
        typer.echo("\nUpdating Projects V2 Status → Done:")
        v2_succeeded, v2_failed = _bulk_update_project_status(owner, project_number, all_issues, "Done")
        typer.echo(f"  Projects V2: {v2_succeeded} updated, {v2_failed} failed.")

    if failed:
        raise typer.Exit(1)


def _transition_to_done(open_issues: list[Issue], done_label: Label) -> tuple[int, int, int]:
    """Apply status:done label to each open issue.

    Returns:
        Tuple of (succeeded, skipped, failed) counts.
    """
    status_labels_to_remove = {"status:in-progress", "status:needs-grooming"}
    succeeded = failed = skipped = 0
    typer.echo()
    for issue in open_issues:
        label_names = [lbl.name for lbl in issue.labels]
        if "status:done" in label_names:
            typer.echo(f"  #{issue.number}  already has status:done — skipped")
            skipped += 1
            continue
        try:
            new_label_names = [lbl.name for lbl in issue.labels if lbl.name not in status_labels_to_remove]
            new_label_names.append(done_label.name)
            issue.edit(labels=new_label_names)
            typer.echo(f"  #{issue.number}  {issue.title[:60]}  → status:done")
            succeeded += 1
        except GithubException as exc:
            typer.echo(f"  #{issue.number}  FAILED: {exc}", err=True)
            failed += 1
    return succeeded, skipped, failed


def _get_open_milestone(repository: Repository, number: int) -> Milestone:
    """Fetch a milestone and verify it is open.

    Args:
        repository: GitHub repository object.
        number: Milestone number.

    Returns:
        The Milestone object.

    Raises:
        typer.Exit: If the milestone is not found or already closed.
    """
    try:
        milestone = repository.get_milestone(number)
    except GithubException as exc:
        typer.echo(f"ERROR: Milestone #{number} not found.", err=True)
        open_milestones = list(repository.get_milestones(state="open"))
        if open_milestones:
            typer.echo("Open milestones:", err=True)
            for m in open_milestones:
                typer.echo(f"  #{m.number}  {m.title}", err=True)
        raise typer.Exit(1) from exc

    if milestone.state == "closed":
        typer.echo(f"ERROR: Milestone #{number} '{milestone.title}' is already closed.", err=True)
        raise typer.Exit(1)

    return milestone


def _find_gh_cli() -> str:
    """Locate the gh CLI binary.

    Returns:
        Path to gh binary.

    Raises:
        typer.Exit: If gh is not found on PATH.
    """
    gh_path = shutil.which("gh")
    if not gh_path:
        typer.echo("ERROR: gh CLI not found. Install gh via your system package manager (brew/winget/apt).", err=True)
        raise typer.Exit(1)
    return gh_path


def _gh_graphql(query: str) -> dict:
    """Execute a GraphQL query via the gh CLI.

    Args:
        query: GraphQL query string.

    Returns:
        Parsed JSON response from the GitHub GraphQL API.

    Raises:
        typer.Exit: If the gh CLI call fails.
    """
    gh_path = _find_gh_cli()
    try:
        result = subprocess.run(
            [gh_path, "api", "graphql", "-f", f"query={query}"], capture_output=True, text=True, check=True
        )
    except subprocess.CalledProcessError as exc:
        typer.echo(f"ERROR: GraphQL query failed: {exc.stderr or exc}", err=True)
        raise typer.Exit(1) from exc
    return json.loads(result.stdout)


def _discover_project_fields(owner: str, project_number: int) -> tuple[str, str, dict[str, str]]:
    """Discover project ID, Status field ID, and option IDs via GraphQL.

    Args:
        owner: GitHub user or organization login.
        project_number: The project number (visible in the URL).

    Returns:
        Tuple of (project_id, status_field_id, option_map) where
        option_map maps status name to option ID.

    Raises:
        typer.Exit: If project or Status field not found.
    """
    query = (
        '{ user(login: "' + owner + '") { projectV2(number: ' + str(project_number) + ") { id fields(first: 30) {"
        " nodes { ... on ProjectV2SingleSelectField {"
        " id name options { id name } } } } } } }"
    )
    resp = _gh_graphql(query)

    project = resp.get("data", {}).get("user", {}).get("projectV2")
    if not project:
        typer.echo(f"ERROR: Project #{project_number} not found for user '{owner}'.", err=True)
        raise typer.Exit(1)

    project_id = project["id"]
    for field in project["fields"]["nodes"]:
        if field.get("name") == "Status":
            field_id = field["id"]
            option_map = {opt["name"]: opt["id"] for opt in field["options"]}
            return project_id, field_id, option_map

    typer.echo(f"ERROR: No 'Status' field found in project #{project_number}.", err=True)
    raise typer.Exit(1)


def _find_project_item_id(project_id: str, issue_node_id: str) -> str:
    """Find or create the project item for a given issue.

    Adds the issue to the project if not already present. The
    ``addProjectV2ItemById`` mutation is idempotent — it returns the
    existing item if the issue is already on the board.

    Args:
        project_id: GraphQL node ID of the project.
        issue_node_id: GraphQL node ID of the issue.

    Returns:
        The project item ID.

    Raises:
        typer.Exit: If the mutation fails to return an item ID.
    """
    query = (
        "mutation { addProjectV2ItemById(input: {"
        f'projectId: "{project_id}", contentId: "{issue_node_id}"'
        "}) { item { id } } }"
    )
    resp = _gh_graphql(query)
    item_id = resp.get("data", {}).get("addProjectV2ItemById", {}).get("item", {}).get("id")
    if not item_id:
        typer.echo("ERROR: Failed to add issue to project.", err=True)
        raise typer.Exit(1)
    return item_id


def _set_project_field(project_id: str, item_id: str, field_id: str, option_id: str) -> None:
    """Set a single-select field value on a project item.

    Args:
        project_id: GraphQL node ID of the project.
        item_id: GraphQL node ID of the project item.
        field_id: GraphQL node ID of the field.
        option_id: GraphQL node ID of the option to set.
    """
    query = (
        "mutation { updateProjectV2ItemFieldValue(input: {"
        f'projectId: "{project_id}", itemId: "{item_id}", '
        f'fieldId: "{field_id}", '
        f'value: {{singleSelectOptionId: "{option_id}"}}'
        "}) { projectV2Item { id } } }"
    )
    _gh_graphql(query)


def _update_project_status(
    owner: str, project_number: int, issue_node_id: str, status: str, *, dry_run: bool = False, issue_label: str = ""
) -> bool:
    """Update the Projects V2 Status field for a single issue.

    This is the shared implementation used by both the ``project update-status``
    command and the milestone start/close integration.

    Args:
        owner: GitHub user or organization login.
        project_number: The project number.
        issue_node_id: GraphQL node ID of the issue.
        status: Target status value (must be in VALID_STATUSES).
        dry_run: If True, report what would happen without mutating.
        issue_label: Optional label for dry-run output (e.g. "#42 title").

    Returns:
        True if the update succeeded (or would succeed in dry-run).
    """
    if status not in VALID_STATUSES:
        typer.echo(f"ERROR: Invalid status '{status}'. Valid values: {', '.join(VALID_STATUSES)}", err=True)
        return False

    project_id, field_id, option_map = _discover_project_fields(owner, project_number)

    option_id = option_map.get(status)
    if not option_id:
        typer.echo(
            f"ERROR: Status '{status}' not found in project options. Available: {', '.join(option_map)}", err=True
        )
        return False

    if dry_run:
        label = issue_label or issue_node_id
        typer.echo(f"  [dry-run] Would set {label} → Status: {status}")
        return True

    item_id = _find_project_item_id(project_id, issue_node_id)
    _set_project_field(project_id, item_id, field_id, option_id)

    label = issue_label or issue_node_id
    typer.echo(f"  {label} → Status: {status}")
    return True


def _bulk_update_project_status(
    owner: str, project_number: int, issues: list[Issue], status: str, *, dry_run: bool = False
) -> tuple[int, int]:
    """Update Projects V2 Status for multiple issues.

    Discovers project fields once and reuses for all issues.

    Args:
        owner: GitHub user or organization login.
        project_number: The project number.
        issues: List of PyGithub Issue objects.
        status: Target status value.
        dry_run: If True, report without mutating.

    Returns:
        Tuple of (succeeded, failed) counts.
    """
    if status not in VALID_STATUSES:
        typer.echo(f"ERROR: Invalid status '{status}'. Valid values: {', '.join(VALID_STATUSES)}", err=True)
        return 0, len(issues)

    project_id, field_id, option_map = _discover_project_fields(owner, project_number)
    option_id = option_map.get(status)
    if not option_id:
        typer.echo(
            f"ERROR: Status '{status}' not found in project options. Available: {', '.join(option_map)}", err=True
        )
        return 0, len(issues)

    succeeded = failed = 0
    for issue in issues:
        label = f"#{issue.number}  {issue.title[:50]}"
        if dry_run:
            typer.echo(f"  [dry-run] Would set {label} → Status: {status}")
            succeeded += 1
            continue
        try:
            item_id = _find_project_item_id(project_id, issue.node_id)
            _set_project_field(project_id, item_id, field_id, option_id)
            typer.echo(f"  {label} → Status: {status}")
            succeeded += 1
        except (typer.Exit, subprocess.CalledProcessError) as exc:
            typer.echo(f"  {label} FAILED: {exc}", err=True)
            failed += 1
    return succeeded, failed


def _ensure_label(repository: Repository, name: str, color: str, description: str) -> Label:
    """Return the label, creating it if it does not exist.

    Args:
        repository: GitHub repository object.
        name: Label name to find or create.
        color: Hex color code for the label (without ``#`` prefix).
        description: Human-readable label description.

    Returns:
        The existing or newly created Label object.
    """
    try:
        return repository.get_label(name)
    except GithubException:
        label = repository.create_label(name=name, color=color, description=description)
        typer.echo(f"\n  Created label: {name}")
        return label


def _transition_issues(open_issues: list[Issue], in_progress_label: Label) -> tuple[int, int, int]:
    """Apply label transition from ``status:needs-grooming`` to ``status:in-progress``.

    Args:
        open_issues: List of open Issue objects to transition.
        in_progress_label: The ``status:in-progress`` Label to apply.

    Returns:
        Tuple of (succeeded, skipped, failed) counts.
    """
    succeeded = failed = skipped = 0
    typer.echo()
    for issue in open_issues:
        label_names = [lbl.name for lbl in issue.labels]
        if "status:in-progress" in label_names:
            typer.echo(f"  #{issue.number}  already has status:in-progress — skipped")
            skipped += 1
            continue
        try:
            new_label_names = [lbl.name for lbl in issue.labels if lbl.name != "status:needs-grooming"]
            new_label_names.append(in_progress_label.name)
            issue.edit(labels=new_label_names)
            typer.echo(f"  #{issue.number}  {issue.title[:60]}  → status:in-progress")
            succeeded += 1
        except GithubException as exc:
            typer.echo(f"  #{issue.number}  FAILED: {exc}", err=True)
            failed += 1
    return succeeded, skipped, failed


@project_app.command("update-status")
def project_update_status(
    issue_number: Annotated[int, typer.Option("--issue-number", "-i", help="GitHub issue number")],
    status: Annotated[str, typer.Option("--status", "-s", help="Target status value")],
    project_number: Annotated[int, typer.Option("--project-number", "-p", help="Project number")] = 1,
    owner: Annotated[str, typer.Option("--owner")] = "Jamie-BitFlight",
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
) -> None:
    """Set the Projects V2 Status field for a GitHub issue.

    Discovers field IDs dynamically via GraphQL, then updates the Status
    single-select field. The issue is added to the project if not already present.

    Valid statuses: Backlog, Grooming, In Progress, In Review, Done
    """
    if status not in VALID_STATUSES:
        typer.echo(f"ERROR: Invalid status '{status}'. Valid values: {', '.join(VALID_STATUSES)}", err=True)
        raise typer.Exit(1)

    gh = get_github()
    repository = get_repo(gh, repo)

    try:
        issue = repository.get_issue(issue_number)
    except GithubException as exc:
        typer.echo(f"ERROR: Issue #{issue_number} not found: {exc}", err=True)
        raise typer.Exit(1) from exc

    typer.echo(f"Issue #{issue.number}: {issue.title}")
    typer.echo(f"  Project: {owner}/projects/{project_number}")
    typer.echo(f"  Target status: {status}")

    ok = _update_project_status(
        owner=owner,
        project_number=project_number,
        issue_node_id=issue.raw_data["node_id"],
        status=status,
        dry_run=dry_run,
        issue_label=f"#{issue.number}  {issue.title[:50]}",
    )
    if not ok:
        raise typer.Exit(1)
    if not dry_run:
        typer.echo("  Done.")


@issue_app.command("create")
def issue_create(
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    title: Annotated[str, typer.Option("--title")] = "",
    body: Annotated[str, typer.Option("--body")] = "",
    priority_label: Annotated[str, typer.Option("--priority-label")] = "",
    type_label: Annotated[str, typer.Option("--type-label")] = "",
    milestone_number: Annotated[int, typer.Option("--milestone")] = 0,
) -> None:
    """Create a GitHub issue with priority/type labels and optional milestone."""
    if not title:
        typer.echo("ERROR: --title is required", err=True)
        raise typer.Exit(1)

    gh = get_github()
    repository = get_repo(gh, repo)

    label_names = ["status:needs-grooming"]
    if priority_label:
        label_names.append(priority_label)
    if type_label:
        label_names.append(type_label)

    label_objects = []
    for lbl_name in label_names:
        try:
            label_objects.append(repository.get_label(lbl_name))
        except GithubException:
            typer.echo(f"  WARNING: label '{lbl_name}' not found — skipping", err=True)

    milestone_obj = None
    if milestone_number:
        try:
            milestone_obj = repository.get_milestone(milestone_number)
        except GithubException:
            typer.echo(f"  WARNING: milestone #{milestone_number} not found — skipping", err=True)

    if milestone_obj is not None:
        issue = repository.create_issue(title=title, body=body or "", labels=label_objects, milestone=milestone_obj)
    else:
        issue = repository.create_issue(title=title, body=body or "", labels=label_objects)
    typer.echo(f"Created issue #{issue.number}: {issue.title}")
    typer.echo(f"  URL: {issue.html_url}")


@issue_app.command("list")
def issue_list(
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    priority: Annotated[str, typer.Option("--priority")] = "",
    state: Annotated[str, typer.Option("--state")] = "open",
) -> None:
    """List issues, optionally filtered by priority."""
    gh = get_github()
    repository = get_repo(gh, repo)

    kwargs: dict = {"state": state}
    if priority:
        label_name = PRIORITY_LABEL_MAP.get(priority.upper(), f"priority:{priority.lower()}")
        try:
            kwargs["labels"] = [repository.get_label(label_name)]
        except GithubException:
            typer.echo(f"Label '{label_name}' not found", err=True)

    issues = list(repository.get_issues(**kwargs))
    if not issues:
        typer.echo("No issues found.")
        return
    for issue in issues:
        milestone_title = issue.milestone.title if issue.milestone else "—"
        label_names = ", ".join(lbl.name for lbl in issue.labels)
        typer.echo(f"  #{issue.number:4d}  {issue.title[:55]:<55}  [{label_names}]  {milestone_title}")


@app.command()
def setup(
    repo: Annotated[str, typer.Option("--repo", "-R")] = DEFAULT_REPO,
    project_title: Annotated[str, typer.Option("--project-title")] = "claude_skills Backlog",
) -> None:
    """Full project setup: create label taxonomy and report next steps."""
    typer.echo(f"Setting up GitHub project for {repo}...")
    typer.echo("\n1. Creating label taxonomy...")

    gh = get_github()
    repository = get_repo(gh, repo)

    existing = {lbl.name: lbl for lbl in repository.get_labels()}
    created = skipped = 0
    for spec in LABELS:
        if spec["name"] not in existing:
            repository.create_label(name=spec["name"], color=spec["color"], description=spec["description"])
            typer.echo(f"   created: {spec['name']}")
            created += 1
        else:
            skipped += 1

    typer.echo(f"   Labels: {created} created, {skipped} already existed")

    typer.echo(f"\n2. Project '{project_title}' — create via gh CLI:")
    typer.echo(f'   gh project create --owner {repo.split("/")[0]} --title "{project_title}"')
    typer.echo("\nNote: GitHub Projects V2 requires project OAuth scope.")
    typer.echo("      Use gh project commands or the GraphQL API for project creation.")
    typer.echo("      See .claude/skills/gh/references/projects-v2.md for field setup commands.")


if __name__ == "__main__":
    app()
