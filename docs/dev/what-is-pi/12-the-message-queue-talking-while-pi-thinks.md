# The Message Queue — Talking While Pi Thinks

Pi doesn't make you wait for the agent to finish before sending more instructions. You can queue messages while the agent is streaming:

| Key | Behavior |
|-----|----------|
| **Enter** | Queue a **steering** message — delivered after current tool, interrupts remaining tools |
| **Alt+Enter** | Queue a **follow-up** message — delivered after agent finishes all work |
| **Escape** | Abort the agent and restore queued messages to editor |
| **Alt+Up** | Retrieve queued messages back to editor |

**Steering** is for course-correction: "Stop, do this instead." The message is delivered after the current tool finishes, but remaining tool calls in the LLM's response are skipped.

**Follow-up** is for chaining: "After you're done with that, also do this." The message waits until the agent has no more tool calls to make.

**Settings:**
- `steeringMode`: `"one-at-a-time"` (default) or `"all"` (deliver all queued at once)
- `followUpMode`: same options

---
