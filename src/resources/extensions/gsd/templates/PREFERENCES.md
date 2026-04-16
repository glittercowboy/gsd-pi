---
version: 1
mode:
always_use_skills: []
prefer_skills: []
avoid_skills: []
skill_rules: []
custom_instructions: []
models: {}
skill_discovery:
skill_staleness_days:
auto_supervisor: {}
git:
  auto_push:
  push_branches:
  remote:
  snapshots:
  pre_merge_check:
  commit_type:
  main_branch:
  merge_strategy:
  isolation:
  manage_gitignore:
  worktree_post_create:
unique_milestone_ids:
budget_ceiling:
budget_enforcement:
context_pause_threshold:
token_profile:
phases:
  skip_research:
  skip_reassess:
  reassess_after_slice:
  skip_slice_research:
dynamic_routing:
  enabled:
  tier_models: {}
  escalate_on_failure:
  budget_pressure:
  cross_provider:
  hooks:
uok:
  enabled: true
  legacy_fallback:
    enabled: false
  gates:
    enabled: true
  model_policy:
    enabled: true
  execution_graph:
    enabled: true
  gitops:
    enabled: true
    turn_action: status-only
    turn_push: false
  audit_unified:
    enabled: true
  plan_v2:
    enabled: true
auto_visualize:
auto_report:
parallel:
  enabled:
  max_workers:
  budget_ceiling:
  merge_strategy:
  auto_merge:
verification_commands: []
verification_auto_fix:
verification_max_retries:
notifications:
  enabled:
  on_complete:
  on_error:
  on_budget:
  on_milestone:
  on_attention:
cmux:
  enabled:
  notifications:
  sidebar:
  splits:
  browser:
remote_questions:
  channel:
  channel_id:
  timeout_minutes:
  poll_interval_seconds:
uat_dispatch:
post_unit_hooks: []
pre_dispatch_hooks: []
# language:
# experimental:
#   rtk: false
---

# GSD Skill Preferences

See `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.
