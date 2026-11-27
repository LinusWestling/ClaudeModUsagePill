# Usage Pill

A Claude Code mod for the desktop app. It adds a bordered bar above the prompt, so you can see where a task, your limits and your cache stand without opening anything.

```
Fixing contrast ▰▰▰▱▱ 2/5  |  ≡ 23% · 41% wk ↻ 14:14  |  ▬ 48k ctx  ● warm
```

## What it shows

The bar has three groups.

| Group | Meaning |
| --- | --- |
| **Task** | The task's label, one bar segment per step of Claude's task list, and a count like `2/5`. The current step pulses. With no task list, a short bar sweeps instead of showing a made-up percentage. With no task at all, the mascot and a dim `Ready`. It always leads and takes the spare width, so the figures sit together on the right. |
| **Limits** | Two stacked bars, the 5-hour session limit on top and the weekly one below, then `23% · 41% wk` and the session's reset as a clock time, like `↻ 14:14`. When you are on pace to run out before the reset it reads `78% · out ~16:40`. |
| **Context and cache** | A short bar of the context window with the tokens in it, like `48k ctx`, then a dot and `warm` or `cold`, or `cools 4m` when the cache is about to go cold. The two halves open different details. |

When calm the border is a plain hairline. Limits and context turn amber at 70% and red at 90%: only the group at risk gets a tint, and the border takes its colour. A cooling cache tints only its own word and dot. On a narrow window words go before figures: first the reset clock and `wk`, then the task's label and the `ctx` and cache words, then the week bar, and only then the cache and context.

The bar and every chart follow the app's light or dark mode. The bar has an opaque background of its own, so it stays readable even where an image is drawn in the other mode's colours.

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
| Limits | **Limits**: the session percent and when it resets, a chart of the 5-hour window on a real clock (used so far, the pace line, the limit, and the stretch you would be blocked), three small tiles (`At this pace`, `This session`, `Pace`), and a week row with its bar and reset. |
| Context | **Context**: a bar of the whole window with the used part split by category, then the categories in two groups, `Conversation` and `Always loaded`, each with its subtotal. The largest row is highlighted. When the bar has no room for every category, the smallest fold into one `▾ n more` row; click it to show them all, and `▴ Show less` to fold them again. A footer gives what the last turn added and its largest tool result, and **Compact now**. |
| Cache | **Cache**: warm or cold, the minutes left and the time it cools, with a bar of the cache's hour and a mark where the warning comes. What your next message costs sent now against after it cools, in token-equivalents (a cache read costs a tenth of an input token, a cold start writes everything again at twice). The last reply split into tokens read from the cache, newly written and uncached. One bar per reply this session with cold starts in red, the hit rate, what the cache saved and when the cold starts were. A switch turns the five-minute warning off or on (kept across sessions), and **Compact now**. On a short bar the sections that matter least drop out first. |

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

## Changed files

Under the agents, in both tabs, **Changed files** lists every file edited this session (until the first edit it says so in one dim line), by you or a subagent, the latest first: `M` or `A` (added by a write to a new file), the path, `+n −n`, and a small bar of added against removed. Only edits that went through count. The header totals the lines, and a filter row narrows the list to `You` or one agent. Press a file to open its diff right there, the first two hunks shown and the rest behind `n more hunks`, with **Copy path** and who made the edits. **Collapse all** closes every open file. The list keeps the whole session; a new prompt doesn't clear it.

The diff is built from the edits themselves, reading the file just before each one so lines land at their real numbers. When a session starts with an empty list, for example after a restart or an update, the list is read back from the transcripts of the conversation and its agents; those diffs are placed where their new lines now stand in the file. It isn't `git diff`: a formatter that rewrites the file afterwards doesn't show. A file can't be seen being deleted, so there is no `D`. A file keeps at most about 400 diff lines, and the list 200 files.

## Known limits

- **Tuned by eye for one setup.** The app doesn't let a mod style its rectangle above the prompt, so the bar is drawn over it, using pixel measurements taken from screenshots of the macOS and Windows desktop apps. It may sit a pixel or two off at other window widths, or further off on Linux and other app versions. To adjust it, change `MACOS` or `WINDOWS` in `hooks/pill.ts`, and `CELL_WIDTH` in `hooks/register.tsx`.
- **Warm and cold are an estimate.** Claude Code doesn't report the cache's state, so the mod counts one hour from the last request. If your requests use the five-minute lifetime, for example on extra usage, it can say `Warm` after the cache has gone cold.
- **The task bar depends on the desktop app.** It reads the desktop app's task-list tool, so other surfaces show the sweeping bar instead.
- **Also tuned by eye.** The headroom row, the details under the bar, the timeline and the limit chart were tuned by eye on macOS dark mode. Each chip's hover area is laid in whole cells, so it keeps the same gap from the dividers on any screen, and where it sits follows the same measured cell width as the bar.
- **Light mode follows the page.** The bar and charts are images, which can't read the app's theme. They take the page's light or dark preference instead. Where the two differ the bar keeps its dark background and stays readable; the charts in the details may read faintly.
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

The code is in `hooks/`: `register.tsx` holds the hooks, `pill.ts` draws the bar, `task.ts` follows the task list, `feed.ts` keeps each agent's tool calls `chat.ts` turns an agent's transcript and live stream into chat rows, `forecast.ts` holds the limit pace and its chart, `headroom.tsx` the context row and cache warnings, `cache.ts` the Cache module's figures and pictures, `timeline.ts` the timeline's scale and drawing, `popover.tsx` the details under the bar, `receipt.tsx` the session's ledger, `notify.ts` the done notification, `files.tsx` the Changed files section with `filediff.ts` its line diff, and `scheme.ts` the drawings' light-mode colours.

## License

[MIT](LICENSE)
