# Workflow Templates

Workflow templates are pre-built patterns for common development tasks. Instead of setting up a full milestone for a quick bugfix or spike, use a template to get started immediately.

## Using Templates

```
/gsd start              # pick from available templates
/gsd start resume       # resume an in-progress workflow
```

## Available Templates

| Template | Purpose |
|----------|---------|
| `bugfix` | Fix a specific bug with diagnosis and verification |
| `spike` | Time-boxed investigation or prototype |
| `feature` | Standard feature development |
| `hotfix` | Urgent production fix |
| `refactor` | Code restructuring and cleanup |
| `security-audit` | Security review and remediation |
| `dep-upgrade` | Dependency update and migration |
| `full-project` | Complete project from scratch |

## Listing and Inspecting

```
/gsd templates                    # list all available templates
/gsd templates info <name>        # show details for a template
```

## Custom Workflows

Create your own workflow definitions:

```
/gsd workflow new                  # create a new workflow YAML
/gsd workflow run <name>           # start a workflow run
/gsd workflow list                 # list active runs
/gsd workflow validate <name>      # validate definition
/gsd workflow pause                # pause running workflow
/gsd workflow resume               # resume paused workflow
```

Custom workflows are defined in YAML and can specify phases, dependencies, and configuration for each step.
