#!/usr/bin/env -S uv --quiet run --active --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "typer>=0.21.0",
#   "PyGithub>=2.1.1",
# ]
# ///
"""Experiment cleanup — removes GitHub resources created during workflow experiments.

Deletes only resources tagged with the experiment prefix to avoid clobbering
production data. Safe to run between iterations.

Usage:
    experiment_cleanup.py run  --repo OWNER/REPO [--prefix experiment/] [--dry-run]
    experiment_cleanup.py list --repo OWNER/REPO [--prefix experiment/]
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Annotated

import typer
from github import Auth, Github, GithubException

if TYPE_CHECKING:
    from github.Label import Label
    from github.Repository import Repository

app = typer.Typer(help="Remove experiment-created GitHub resources between test iterations")

EXPERIMENT_LABELS = [
    "priority:p0",
    "priority:p1",
    "priority:p2",
    "priority:idea",
    "type:feature",
    "type:bug",
    "type:refactor",
    "type:docs",
    "type:chore",
    "status:in-progress",
    "status:blocked",
    "status:needs-grooming",
    "status:needs-review",
]

EXPERIMENT_MILESTONE_PREFIX = "v1.0"
EXPERIMENT_PROJECT_TITLE = "claude_skills Backlog"


def get_gh(repo_slug: str) -> tuple[Github, Repository]:
    """Authenticate and return a Github client and Repository.

    Args:
        repo_slug: Repository identifier in ``owner/repo`` format.

    Returns:
        Tuple of authenticated Github client and Repository object.
    """
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        typer.echo("ERROR: GITHUB_TOKEN not set", err=True)
        raise typer.Exit(1)
    gh = Github(auth=Auth.Token(token))
    try:
        return gh, gh.get_repo(repo_slug)
    except GithubException as exc:
        typer.echo(f"ERROR: Cannot access repo '{repo_slug}': {exc}", err=True)
        raise typer.Exit(1) from exc


@app.command()
def list_resources(
    repo: Annotated[str, typer.Option("--repo", help="owner/repo")] = "Jamie-BitFlight/claude_skills",
) -> None:
    """List experiment-created resources that would be removed."""
    _, repository = get_gh(repo)

    typer.echo("=== Labels (experiment taxonomy) ===")
    existing = {label.name for label in repository.get_labels()}
    for name in EXPERIMENT_LABELS:
        mark = "[EXISTS]" if name in existing else "[absent]"
        typer.echo(f"  {mark} {name}")

    typer.echo("\n=== Milestones ===")
    for ms in repository.get_milestones(state="open"):
        if ms.title.startswith(EXPERIMENT_MILESTONE_PREFIX):
            typer.echo(f"  [EXISTS] #{ms.number} {ms.title}")

    typer.echo("\n=== Issues with experiment labels ===")
    for label_name in EXPERIMENT_LABELS:
        if label_name not in existing:
            continue
        label_obj = repository.get_label(label_name)
        for issue in repository.get_issues(labels=[label_obj], state="all"):
            typer.echo(f"  #{issue.number} [{issue.state}] {issue.title}")


def _close_issues(repository: Repository, existing_labels: dict[str, Label], prefix: str, dry_run: bool) -> int:
    """Close open issues that carry any experiment label.

    Args:
        repository: GitHub repository object.
        existing_labels: Mapping of label name to Label object.
        prefix: Log prefix for dry-run mode.
        dry_run: If True, only print what would happen.

    Returns:
        Number of issues closed.
    """
    closed = 0
    for label_name in EXPERIMENT_LABELS:
        if label_name not in existing_labels:
            continue
        label_obj = existing_labels[label_name]
        for issue in repository.get_issues(labels=[label_obj], state="open"):
            typer.echo(f"{prefix}Close issue #{issue.number}: {issue.title}")
            if not dry_run:
                issue.edit(state="closed")
                closed += 1
    return closed


def _delete_labels(existing_labels: dict[str, Label], prefix: str, dry_run: bool) -> int:
    """Delete experiment taxonomy labels.

    Args:
        existing_labels: Mapping of label name to Label object.
        prefix: Log prefix for dry-run mode.
        dry_run: If True, only print what would happen.

    Returns:
        Number of labels deleted.
    """
    deleted = 0
    for name, label_obj in existing_labels.items():
        if name in EXPERIMENT_LABELS:
            typer.echo(f"{prefix}Delete label: {name}")
            if not dry_run:
                label_obj.delete()
                deleted += 1
    return deleted


def _close_milestones(repository: Repository, prefix: str, dry_run: bool) -> int:
    """Close milestones with the experiment title prefix.

    Args:
        repository: GitHub repository object.
        prefix: Log prefix for dry-run mode.
        dry_run: If True, only print what would happen.

    Returns:
        Number of milestones closed.
    """
    closed = 0
    for ms in repository.get_milestones(state="open"):
        if ms.title.startswith(EXPERIMENT_MILESTONE_PREFIX):
            typer.echo(f"{prefix}Close milestone #{ms.number}: {ms.title}")
            if not dry_run:
                ms.edit(title=ms.title, state="closed")
                closed += 1
    return closed


@app.command()
def run(
    repo: Annotated[str, typer.Option("--repo", help="owner/repo")] = "Jamie-BitFlight/claude_skills",
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Print actions without executing")] = False,
) -> None:
    """Remove experiment-created labels, milestones, and issues."""
    _, repository = get_gh(repo)
    prefix = "[DRY-RUN] " if dry_run else ""

    existing_labels = {label.name: label for label in repository.get_labels()}
    issues_closed = _close_issues(repository, existing_labels, prefix, dry_run)
    deleted_labels = _delete_labels(existing_labels, prefix, dry_run)
    closed_milestones = _close_milestones(repository, prefix, dry_run)

    typer.echo("\nCleanup summary:")
    typer.echo(f"  Issues closed:     {issues_closed}")
    typer.echo(f"  Labels deleted:    {deleted_labels}")
    typer.echo(f"  Milestones closed: {closed_milestones}")
    if dry_run:
        typer.echo("  (dry-run — no changes made)")


if __name__ == "__main__":
    app()
