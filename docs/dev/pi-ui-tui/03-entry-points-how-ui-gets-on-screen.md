# Entry Points — How UI Gets on Screen

There are **six different ways** to put custom UI on screen, each for a different purpose:

| Method | Purpose | Blocks? | Replaces editor? |
|--------|---------|---------|-------------------|
| `ctx.ui.select/confirm/input/editor` | Quick dialogs | Yes | Temporarily |
| `ctx.ui.notify` | Toast notifications | No | No |
| `ctx.ui.setStatus` | Footer status text | No | No |
| `ctx.ui.setWidget` | Persistent widget above/below editor | No | No |
| `ctx.ui.setFooter` | Replace entire footer | No | No (replaces footer) |
| `ctx.ui.custom()` | Full custom component | Yes | Temporarily |
| `ctx.ui.custom({overlay})` | Floating overlay | Yes | No (renders on top) |
| `ctx.ui.setEditorComponent` | Replace editor permanently | No | Yes (permanently) |
| `ctx.ui.setHeader` | Custom startup header | No | No (replaces header) |
| `renderCall/renderResult` | Tool display | No | No (inline in messages) |
| `registerMessageRenderer` | Custom message display | No | No (inline in messages) |

---
