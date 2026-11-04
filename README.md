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

While subagents run, a sidebar lists each one with its model, effort, what it is doing and its progress, drawn by a Claude mascot in its own outfit. It opens when the first agent starts. To open it yourself, press the mascot in the bar's `Working` section, or run `/subagents`. The mascot in the bar walks while any subagent is running.

An agent doesn't report how far along it is, so progress is what can be counted: steps if it keeps a task list, then tools run, time and tokens. There is no made-up percentage.

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

The code is in `hooks/`: `register.tsx` holds the hooks, `pill.ts` draws the bar and `task.ts` follows the task list.

## License

[MIT](LICENSE)
