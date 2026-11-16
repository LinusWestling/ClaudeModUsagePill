# Usage Pill

A Claude Code mod for the desktop app. It adds a bordered bar above the prompt, so you can see where a task, your limits and your cache stand without opening anything.

```
Working ▰▰▰▱▱ 3/5  |  ◔ 14% session  |  ◔ 11% week  |  ◔ 370k / 1M  |  ◕ Warm cache
```

## What it shows

| Section | Meaning |
| --- | --- |
| **Task** | `Working` or `Done`, one bar segment per step of Claude's task list, and a count like `3/5`. The current step pulses. With no task list, a short bar sweeps instead of showing a made-up percentage. |
| **Session** | How much of your 5-hour plan limit is used. |
| **Week** | How much of your weekly plan limit is used. |
| **Context** | Tokens in the context window against its size. |
| **Cache** | `Warm` or `Cold`. The ring empties as the cache ages. |

Limits and context turn amber at 70% and red at 90%. The border takes the colour of whichever is highest. On a narrow window the bar drops week first, then cache, then context.

Session and week only appear on a Claude subscription, once a response has reported them.

## Install

At the prompt of a terminal session:

```
/plugin install usage-pill --marketplace LinusWestling/ClaudeModUsagePill
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install usage-pill --marketplace LinusWestling/ClaudeModUsagePill
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `LinusWestling/ClaudeModUsagePill`, then **Add plugin**.

Mods are an early-access part of Claude Code and may change between releases.

## Update

From a shell:

```bash
claude plugin marketplace update claude-mod-usage-pill
```

```bash
claude plugin update usage-pill@claude-mod-usage-pill
```

Then restart Claude Code: the update applies after a restart.

## Subagents

While subagents run, a sidebar lists each one, drawn by a Claude mascot in its own outfit. A running agent gets a card with its model, how long it has run, the step it is on when it keeps a task list, and a live feed of its tool calls: the newest arrives at the bottom with a spinner and a ticking time, and settles to a ✓ or ✗ with how long it took, older calls fading back. `+N earlier` opens the card's full list. While Claude is thinking or writing between calls, the feed says so. A finished agent shrinks to a row with how it ended, how long it took and the first sentence of its report, or a note if it ended before reporting back. **Clear** removes the finished ones. Effort and agent type only show when they differ from the defaults. The sidebar opens when the first agent starts. To open it yourself, press the mascot in the bar's `Working` section, or run `/subagents`. The mascot in the bar walks while any subagent is running.

Each card has a button for the agent's conversation: **● Watch live** while it runs, **Open chat** once it has finished, and **✓ Viewing** for the one on show. In the terminal it switches Claude Code's own transcript view to the agent, with **← Back to main** to return. In the desktop app, which has no such switch for mods, it opens a chat pane instead. The pane has a header with the agent's status, time and progress. The agent's text is formatted as Markdown, its thinking is folded into a row you can open, and each tool call is a row that opens on its input and a clipped result. Its reply streams in as it is written, with a caret at the end, and the pane follows it down. Scroll up and it stops following, with **Jump to latest ↓** to go back. Once the agent finishes, its report is highlighted, and **Copy report** copies it where the app allows. Opening another agent's chat switches the pane to it.

An agent doesn't report how far along it is, so progress is what can be counted: steps if it keeps a task list, then tools run, time and context. There is no made-up percentage.

## Known limits

- **Tuned by eye for one setup.** The app doesn't let a mod style its rectangle above the prompt, so the bar is drawn over it, using pixel measurements taken from screenshots of the macOS and Windows desktop apps. It may sit a pixel or two off at other window widths, or further off on Linux and other app versions. To adjust it, change `MACOS` or `WINDOWS` in `hooks/pill.ts`, and `CELL_WIDTH` in `hooks/register.tsx`.
- **Warm and cold are an estimate.** Claude Code doesn't report the cache's state, so the mod counts one hour from the last request. If your requests use the five-minute lifetime, for example on extra usage, it can say `Warm` after the cache has gone cold.
- **The task bar depends on the desktop app.** It reads the desktop app's task-list tool, so other surfaces show the sweeping bar instead.
- **Terminal.** The terminal gets a plain text version of the same figures. It has not been checked by eye.

## Development

Run from a clone, for one session:

```bash
claude --plugin-dir .
```

Check and test:

```bash
claude plugin validate .
claude plugin test .
```

The code is in `hooks/`: `register.tsx` holds the hooks, `pill.ts` draws the bar, `task.ts` follows the task list, `feed.ts` keeps each agent's tool calls and `chat.ts` turns an agent's transcript and live stream into chat rows.

## License

[MIT](LICENSE)
