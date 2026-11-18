# Usage Pill

A Claude Code mod for the desktop app. It adds a bordered bar above the prompt, so you can see where a task, your limits and your cache stand without opening anything.

```
Working ▰▰▰▱▱ 3/5  |  ◔ 14% session  |  ◔ 11% week  |  ◔ 370k / 1M  |  ◕ Warm cache
```

## What it shows

| Section | Meaning |
| --- | --- |
| **Task** | `Working` or `Done`, one bar segment per step of Claude's task list, and a count like `3/5`. The current step pulses. With no task list, a short bar sweeps instead of showing a made-up percentage. |
| **Session** | How much of your 5-hour plan limit is used, then when it resets as a clock time, like `17% 11:10`. It turns amber when you are on pace to run out first. |
| **Week** | How much of your weekly plan limit is used. |
| **Context** | Tokens in the context window against its size. |
| **Cache** | `Warm` or `Cold`. The ring empties as the cache ages. Reads `Cools 4m` when it is about to go cold. |

Limits and context turn amber at 70% and red at 90%. The border takes the colour of whichever is highest. On a narrow window the bar drops week first, then cache, then context.

Session and week only appear on a Claude subscription, once a response has reported them.

When Claude finishes a turn with every step of its task list done, the mascot in the bar celebrates for 8 seconds: arms up, with confetti. It still does this under reduced motion.

## Forecast and cache

The mod records the 5-hour window's percent over time, across sessions in the same window. From the readings in the last 90 minutes (at least two, 10 minutes apart) it projects your pace. If that pace reaches 100% before the reset, the session chip turns amber, and its alt text and the Limits chart say `out ~16:40` in local time, or `out in 1h 20m` if the time zone is unknown. The chip itself always shows the reset time, or `session` if the time zone is unknown.

With under 10 minutes of warm cache left, the cache chip reads `Cools 4m` in amber. At 5 minutes, while Claude is idle, a toast says "Cache cools in 5 min. Your next message would re-read 410k tokens." On the desktop app a native notification is also booked for that moment. The app drops it if you come back to the session first. The same one-hour estimate caveat applies as for warm and cold.

## Context headroom

From 80% context, a second row appears under the bar. Set the point with `headroomAt`. The row shows:

- `86% context`, in amber, and in red from 90%.
- A small bar of what fills the context, by the categories `/context` uses.
- `+42k last turn`.
- The largest tool result of the last turn (an estimate).
- A **Compact now** button. It compacts the conversation and says how many tokens it saved.

Under the threshold the bar is unchanged.

## Details under the bar

Press a chip in the bar and its details open right under it, above the prompt. One opens at a time. Press the same chip again, press **×**, or send a prompt to close it.

| Chip | Opens |
| --- | --- |
| Session or week | **Limits**: the session percent and when it resets, a chart of the 5-hour window on a real clock (used so far, the pace line, the limit, and the stretch you would be blocked), three small tiles (`At this pace`, `This session`, `Pace`), and a week row with its bar and reset. |
| Context | **Context**: a bar of the whole window with the used part split by category, then the categories in two groups, `Conversation` and `Always loaded`, each with its subtotal. The largest row is highlighted. A footer gives what the last turn added and its largest tool result, and **Compact now**. |
| Cache | **Cache**: warm or cold and when it cools, what your next message reads from the cache, and this session's cache hit rate. |

`/usage` opens Limits. `/receipt` opens **Session**: how long the session has run, its subagents, `≈ $X at API prices` when the session has a cost reading, and who spent the tokens, the main thread and each agent, with bars. Past 6 agents they are grouped by model.

The mascot still opens the Subagents sidebar.

## Notifications

When a turn took at least 2 minutes, a native notification like "Claude finished: 6m 12s · 5/5 steps · 3 agents" is booked 20 seconds out. It is dropped if you return to the session before it fires. A new prompt cancels it. The terminal ignores the delay and notifies at once.

Set the length with `notifyAfterMinutes`. Switch it off with `notifyOnDone`.

## Settings

Set these in the plugin's config.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `headroomAt` | number | 80 | Context percent where the headroom row appears. |
| `notifyOnDone` | boolean | true | Notify when a long turn finishes. |
| `notifyAfterMinutes` | number | 2 | How long a turn must take to notify. |

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

Each card has a button for the agent's conversation: **● Watch live** while it runs and **Open chat** once it has finished. In the terminal it switches Claude Code's own transcript view to the agent, with **← Back to main** to return. In the desktop app, which has no such switch for mods, the sidebar itself turns into the agent's chat, with **← Subagents** to go back to the list you came from. Only that button, or closing the sidebar, leaves the chat.

The chat has a header with the agent's status, time and progress. The agent's text is formatted as Markdown. What it did between two pieces of text is one dim line in plain words, like `Read 7 files, ran 25 commands · 4m 34s · 2 failed`. Open it to see each call, with its kind (`Read`, `Edit`, `Bash`, `Search`), a ✗ if it failed and its time from a second up, and its thinking folded into one row. Each call opens on its input and a clipped result. While the agent works, the line says what it is doing now. Its reply streams in as it is written, with a caret at the end, and the chat follows it down. Scroll up and it stops following, with **Jump to latest ↓** to go back. Once the agent finishes, its report is highlighted, and **Copy report** copies it where the app allows. Opening another agent's chat switches to it.

An agent doesn't report how far along it is, so progress is what can be counted: steps if it keeps a task list, then tools run, time and context. There is no made-up percentage.

The sidebar has two tabs, `Cards` and `Timeline`. Timeline puts every agent on one time axis. Each gets a thin bar from start to end: violet while running, green when done, red if it failed, amber if stopped. A small red dot marks where a tool call failed. On the right are `N tools · m:ss` and a status mark. Press a name to open that agent's chat.

## Known limits

- **Tuned by eye for one setup.** The app doesn't let a mod style its rectangle above the prompt, so the bar is drawn over it, using pixel measurements taken from screenshots of the macOS and Windows desktop apps. It may sit a pixel or two off at other window widths, or further off on Linux and other app versions. To adjust it, change `MACOS` or `WINDOWS` in `hooks/pill.ts`, and `CELL_WIDTH` in `hooks/register.tsx`.
- **Warm and cold are an estimate.** Claude Code doesn't report the cache's state, so the mod counts one hour from the last request. If your requests use the five-minute lifetime, for example on extra usage, it can say `Warm` after the cache has gone cold.
- **The task bar depends on the desktop app.** It reads the desktop app's task-list tool, so other surfaces show the sweeping bar instead.
- **Also tuned by eye.** The headroom row, the details under the bar, the timeline and the limit chart were tuned by eye on macOS dark mode. Where a chip's hover highlight sits depends on the same measured cell width as the bar.
- **Some notifications depend on the desktop app.** The delayed and away-only ones need it. A Claude Code older than 2.1.325 can't cancel a booked one.
- **The largest tool result is an estimate.** It is the result's characters divided by 4.
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

The code is in `hooks/`: `register.tsx` holds the hooks, `pill.ts` draws the bar, `task.ts` follows the task list, `feed.ts` keeps each agent's tool calls `chat.ts` turns an agent's transcript and live stream into chat rows, `forecast.ts` holds the limit pace and its chart, `headroom.tsx` the context row and cache warnings, `timeline.ts` the timeline's scale and drawing, `popover.tsx` the details under the bar, `receipt.tsx` the session's ledger, and `notify.ts` the done notification.

## License

[MIT](LICENSE)
