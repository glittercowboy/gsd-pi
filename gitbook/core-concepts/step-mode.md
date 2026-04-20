# Step Mode

Step mode is GSD's interactive, one-step-at-a-time workflow. You stay in the loop, reviewing output between each step.

## Starting Step Mode

```
/gsd
```

GSD reads the state of your `.gsd/` directory and presents a wizard showing what's completed and what's next. It then executes one unit of work and pauses.

## How It Works

Step mode adapts to your project's current state:

| State | What Happens |
|-------|-------------|
| No `.gsd/` directory | Starts a discussion flow to capture your project vision |
| Milestone exists, no roadmap | Opens a discussion or research phase for the milestone |
| Roadmap exists, slices pending | Plans the next slice or executes the next task |
| Mid-task | Resumes where you left off |

After each unit completes, you see results and decide what to do next. This is ideal for:

- New projects where you want to shape the architecture
- Critical work where you want to review each step
- Learning how GSD works before trusting auto mode

## Steering During Step Mode

Between steps, you can:

- **Discuss** — `/gsd discuss` to talk through architecture decisions
- **Skip** — `/gsd skip` to prevent a unit from being dispatched
- **Undo** — `/gsd undo` to revert the last completed unit
- **Switch to auto** — `/gsd auto` to let GSD continue autonomously

## When to Use Step Mode

- **First milestone** — Review GSD's work before trusting it to run solo
- **Architectural decisions** — When you want to guide the approach
- **Unfamiliar codebases** — When you want to ensure GSD understands the project
- **High-stakes changes** — When mistakes would be costly

## Transitioning to Auto Mode

Once you're comfortable with GSD's approach, switch to auto mode:

```
/gsd auto
```

You can always press **Escape** to pause auto mode and return to step-by-step control.
