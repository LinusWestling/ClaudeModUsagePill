import { expect, test } from 'claude-code/testing'

import { MACOS, SAFETY, SPACE_WIDTH, WINDOWS, buildPill, buttonWidth, chipButtons } from '../hooks/pill'
import type { PillModel } from '../hooks/pill'
import { NO_LEDGER } from '../hooks/receipt'

// The chips of the band are buttons: their extents, the buttons laid over them,
// what each opens, and the Usage pane's Context and Cache sections.

const NOW = Date.parse('2026-11-17T12:00:00Z')
const MIN = 60_000
const CELL = 8.77
const NO_TASK = { steps: [], tools: 0 }

const BAND = {
  plugin: 'usage-pill',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const READING = {
  tokens: 48_200,
  window: 200_000,
  limits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-17T14:14:00Z' },
    { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-20T12:00:00Z' },
  ],
}

const TASK = {
  tools: 5,
  steps: [
    { content: 'Read the code', status: 'completed' },
    { content: 'Build the bar', status: 'in_progress' },
  ],
}

const CACHE = { read: 400_000, written: 9_000, uncached: 1_000, at: NOW - 18 * MIN }

const FULL: PillModel = {
  task: { label: 'Working', count: '1/2', steps: TASK.steps as any },
  session: { percent: 23.5 },
  week: 41,
  context: { percent: 24, label: '48k / 200k' },
  cache: { isWarm: true, percentLeft: 70 },
  isWorking: true,
  mascot: { running: 0 },
}

const CATEGORIES = [
  { name: 'Messages', tokens: 700_000, kind: 'used', color: 'claude' },
  { name: 'System tools', tokens: 120_000, kind: 'used', color: 'inactive' },
  { name: 'System prompt', tokens: 40_000, kind: 'used', color: 'promptBorder' },
  { name: 'Free space', tokens: 140_000, kind: 'free' },
]

/** The panes the stand-in was asked to close. */
const closed: string[] = []

const seed = (on: any, values: Record<string, unknown>, opened: { id: string; title?: string }[] = [], usage: Record<string, unknown> = {}) => {
  const held: Record<string, unknown> = {
    cache: null, minute: 0, task: NO_TASK, ledger: NO_LEDGER, isWorking: false, limitSamples: [], headroom: null, celebrateUntil: 0, popover: null,
    ...values,
  }
  let version = 1

  closed.length = 0

  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: held[e.key] ?? null, version } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    held[e.key] = e.value
    version += 1

    return { value: { isSet: true, version } }
  })
  on('ui.open', (_: unknown, e: { id: string; title?: string }) => {
    opened.push({ id: e.id, title: e.title })

    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({ value: {} }))
  on('ui.close', (_: unknown, e: { id: string }) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('prompt.submit', (_: unknown, e: any) => ({ ...e }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 30 * MIN,
      context: {
        tokens: 860_000,
        window: 1_000_000,
        breakdown: { categories: CATEGORIES, totalTokens: 860_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000 },
      },
      rateLimits: [],
      ...usage,
    },
  }))
}

/** The presses run their opens without being awaited: give them their turn. */
const settle = async (opened: unknown[], count: number) => {
  for (let i = 0; i < 50 && opened.length < count; i++) await new Promise(r => (globalThis as any).setTimeout(r, 1))
}

const dividers = (source: string) => [...source.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="1" height="18" class="divider"/g)].map(m => Number(m[1]))

// ── The extents ──

test('the full bar gives every chip its extent, edge to edge as drawn', () => {
  const pill = buildPill(FULL, 1_200)

  expect(pill.chips.map(c => c.kind)).toEqual(['task', 'session', 'week', 'context', 'cache'])
  // The first starts inside the border; each next one past the hairline the drawing puts between them.
  expect(pill.chips[0]!.x).toBe(MACOS.left + 4)
  expect(dividers(pill.source)).toEqual(pill.chips.slice(0, -1).map(c => Number((c.x + c.width).toFixed(1))))
  pill.chips.slice(1).forEach((c, i) => expect(Math.abs(c.x - (pill.chips[i]!.x + pill.chips[i]!.width + 1)) < 1e-6).toBe(true))
  // The last ends where the row's inset does.
  const last = pill.chips[pill.chips.length - 1]!
  expect(Math.abs(last.x + last.width - (1_200 - 4)) < 1e-6).toBe(true)

  // Each gauge's ring is drawn inside its own chip.
  const rings = [...pill.source.matchAll(/<circle cx="([\d.]+)"[^>]*class="ring"/g)].map(m => Number(m[1]))
  expect(rings.length).toBe(4)
  rings.forEach((cx, i) => {
    const chip = pill.chips[i + 1]!

    expect(cx > chip.x && cx < chip.x + chip.width).toBe(true)
  })
})

test('a narrow bar reports only the chips it kept, for each variant buildPill draws', () => {
  // Narrowing from wide to narrow meets each variant once, in buildPill's order.
  const seen: string[] = []

  for (let width = 1_200; width >= 150; width -= 5) {
    const pill = buildPill(FULL, width)
    const kinds = pill.chips.map(c => c.kind).join(',')

    // Whatever was kept, the extents are where the drawing put its hairlines.
    expect(dividers(pill.source)).toEqual(pill.chips.slice(0, -1).map(c => Number((c.x + c.width).toFixed(1))))
    if (seen[seen.length - 1] !== kinds) seen.push(kinds)
  }

  expect(seen).toEqual([
    'task,session,week,context,cache',
    'task,session,context,cache',
    'task,session,context',
    'task,session',
  ])
})

test('drawn for the band, every chip after the first starts on a cell, and its button with it', () => {
  for (const [width, fit] of [
    [122 * CELL, MACOS],
    [96 * CELL, MACOS],
    [64 * CELL, MACOS],
    [122 * CELL, WINDOWS],
  ] as const) {
    const pill = buildPill(FULL, width, fit, CELL)
    const free = buildPill(FULL, width, fit)
    const buttons = chipButtons(pill.chips, CELL)

    expect(buttons.map(b => b.kind)).toEqual(pill.chips.map(c => c.kind))
    // The task chip's starts where the mascot's button always has.
    expect(buttons[0]!.left).toBe(0)
    // Snapping moves no divider by more than a cell, and the row still ends where it did.
    pill.chips.forEach((c, i) => expect(Math.abs(c.x - free.chips[i]!.x)).toBeLessThanOrEqual(CELL))
    const last = pill.chips[pill.chips.length - 1]!
    const freeLast = free.chips[free.chips.length - 1]!
    expect(Math.abs(last.x + last.width - (freeLast.x + freeLast.width)) < 1e-6).toBe(true)
    // The drawing's hairlines are where the extents say.
    expect(dividers(pill.source)).toEqual(pill.chips.slice(0, -1).map(c => Number((c.x + c.width).toFixed(1))))

    buttons.forEach((b, i) => {
      const chip = pill.chips[i]!
      const start = (b.left + 1) * CELL
      const end = start + buttonWidth(b.spaces)

      // The same left edge as the chip (the first starts inside the row's inset).
      if (i > 0) expect(Math.abs(start - chip.x) < 1e-6).toBe(true)
      else expect(start - chip.x).toBeLessThanOrEqual(CELL)
      // Never past its divider, and at most a space and the margin short of it.
      expect(end).toBeLessThanOrEqual(chip.x + chip.width - SAFETY + 1e-6)
      expect(chip.x + chip.width - end).toBeLessThanOrEqual(SPACE_WIDTH + SAFETY + 1e-6)
    })
  }
})

// ── The band ──

test('on the desktop every chip has its own blank button', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (const key of ['agents', 'chip-session', 'chip-week', 'chip-context', 'chip-cache']) {
    const button: any = await ui.find({ key })

    expect(button?.type).toBe('Button')
    expect(/^ +$/.test(button.props.label)).toBe(true)
  }

  await ui.unmount()
})

test('without a task there is no task button, and the gauges keep theirs', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false }, surface: 'desktop' })

  expect(await ui.find({ key: 'agents' })).toBe(undefined)
  expect((await ui.find({ key: 'chip-session' }) as any)?.type).toBe('Button')
  await ui.unmount()
})

test('on the terminal each figure is a plain button around its text', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  for (const key of ['chip-session', 'chip-week', 'chip-context', 'chip-cache']) {
    expect((await ui.find({ key }) as any)?.type).toBe('Button')
  }

  expect((await ui.find({ type: 'Text', text: /session/ }))?.text).toBe('24% session')
  expect((await ui.find({ type: 'Text', text: /week/ }))?.text).toBe('41% week')
  await ui.unmount()
})

// A mounted drawing is a snapshot of one render: each check draws it afresh.
const press = async ($: any, surface: 'desktop' | 'terminal', key: string) => {
  const ui = await $.ui.mount({ ...BAND, surface })

  await ui.press({ key })
  await ui.unmount()
}

const look = async ($: any, surface: 'desktop' | 'terminal') => {
  const ui = await $.ui.mount({ ...BAND, surface })

  return { ui, text: (await ui.findAll({ type: 'Text' })).map((t: any) => t.text) as string[] }
}

const MODULES = ['Session limit', 'Context', 'Cache', 'Session']

const shown = async ($: any, surface: 'desktop' | 'terminal') => {
  const { ui, text } = await look($, surface)

  await ui.unmount()

  return MODULES.filter(m => text.includes(m))
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`on the ${surface} each chip toggles its own module, and only that one`, async ($, on) => {
    const opened: { id: string; title?: string }[] = []

    seed(on, { reading: READING, cache: CACHE, task: TASK }, opened, { rateLimits: RATES })

    const plan: [string, string][] = [
      ['chip-session', 'Session limit'],
      ['chip-week', 'Session limit'],
      ['chip-context', 'Context'],
      ['chip-cache', 'Cache'],
    ]

    expect(await shown($, surface)).toEqual([])

    for (const [key, module] of plan) {
      await press($, surface, key)
      expect(await shown($, surface)).toEqual([module])
      // The same chip again puts it away.
      await press($, surface, key)
      expect(await shown($, surface)).toEqual([])
    }

    // Opening one replaces the open one: never two at once.
    await press($, surface, 'chip-context')
    await press($, surface, 'chip-cache')
    expect(await shown($, surface)).toEqual(['Cache'])
    await press($, surface, 'chip-session')
    expect(await shown($, surface)).toEqual(['Session limit'])

    // The mascot chip still opens the Subagents pane, not a module.
    if (surface === 'desktop') {
      await press($, surface, 'agents')
      await settle(opened, 1)
      expect(opened[0]?.id).toBe('usage-pill-agents')
    }

    expect(opened.some(o => o.id === 'usage-pill-receipt')).toBe(false)
  })
}

test('the × and a submitted prompt close the module', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK }, [], { rateLimits: RATES })

  await press($, 'desktop', 'chip-context')

  const { ui } = await look($, 'desktop')

  expect(((await ui.find({ key: 'popover-close' })) as any)?.type).toBe('Button')
  await ui.press({ key: 'popover-close' })
  await ui.unmount()
  expect(await shown($, 'desktop')).toEqual([])

  await press($, 'desktop', 'chip-cache')
  expect(await shown($, 'desktop')).toEqual(['Cache'])
  await $.prompt.submit({ text: 'next' } as any)
  expect(await shown($, 'desktop')).toEqual([])
})

test('/receipt opens Session and /usage opens Limits', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK }, [], { rateLimits: RATES })

  await $.session.start({ source: 'startup', cwd: '/repo' } as any)

  await $.command.run({ command: 'receipt', args: '' } as any)
  expect(await shown($, 'terminal')).toEqual(['Session'])

  await $.command.run({ command: 'usage', args: '' } as any)
  expect(await shown($, 'terminal')).toEqual(['Session limit'])
})

test('the side pane of earlier builds is closed at start', async ($, on) => {
  seed(on, {})
  await $.session.start({ source: 'startup', cwd: '/repo' } as any)
  expect(closed).toContain('usage-pill-receipt')
})

// ── The modules ──

const RATES = [
  { kind: 'five_hour', percentUsed: 87, resetsAt: '2026-11-17T19:30:00Z' },
  { kind: 'seven_day', percentUsed: 31, resetsAt: '2026-11-23T08:00:00Z' },
]

const open = async ($: any, surface: 'desktop' | 'terminal', key: string) => {
  await press($, surface, key)

  return look($, surface)
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`Limits on the ${surface}: the session limit, the week, and what this session used`, async ($, on) => {
    seed(on, { reading: READING, cache: CACHE, task: TASK, ledger: { ...NO_LEDGER, sessionLimitAtStart: 38 } }, [], { rateLimits: RATES })

    const { ui, text } = await open($, surface, 'chip-session')
    const t = text

    expect(t).toContain('Session limit')
    expect(t.some(x => x.startsWith('87% ') && x.includes('resets'))).toBe(true)
    expect(t).toContain('Week')
    expect(t.some(x => x.startsWith('31% · resets'))).toBe(true)
    expect(t).toContain('This session used')
    expect(t).toContain('+49%')

    // Neutral below 70 used, amber from it, never green.
    const used: any = await ui.find({ type: 'Text', text: '+49%' })

    expect(used.props.color).toBe(undefined)
    await ui.unmount()
  })

  test(`Context on the ${surface}: the share, a legend by size, and Compact now`, async ($, on) => {
    seed(on, { reading: READING, cache: CACHE, task: TASK })

    const { ui, text } = await open($, surface, 'chip-context')
    const t = text

    expect(t).toContain('Context')
    expect(t).toContain('860k of 1M · 86%')
    expect(t).toContain('Messages')
    expect(t).toContain('700k')
    expect(t).toContain('System tools')
    // The free space fills nothing.
    expect(t.includes('Free space')).toBe(false)
    expect((await ui.find({ key: 'popover-compact' }))?.text).toBe('Compact now')

    if (surface === 'desktop') {
      const svgs: any[] = await ui.findAll({ type: 'Svg' })

      expect(svgs.some(s => String(s.props.alt).startsWith('Context by category: Messages 700k'))).toBe(true)
    }

    await ui.unmount()
  })

  test(`Cache on the ${surface}: warm with its minutes, what the next message reads, and the hint`, async ($, on) => {
    seed(on, { reading: READING, cache: CACHE, task: TASK, ledger: { ...NO_LEDGER, main: { input: 10, cacheRead: 990, cacheWrite: 0, output: 5, requests: 3 } } })

    const { ui, text } = await open($, surface, 'chip-cache')
    const t = text

    expect(t).toContain('Cache')
    expect(t).toContain('Warm · cools in 42m')
    expect(t).toContain('Next message reads 410k tokens from the cache')
    expect(t).toContain('Cache hit 99% this session')
    expect(t).toContain('Cold: the next message re-sends everything at full price')
    await ui.unmount()
  })

  test(`a cold cache says so on the ${surface}`, async ($, on) => {
    seed(on, { reading: READING, cache: { ...CACHE, at: NOW - 61 * MIN }, task: TASK })

    const { ui, text } = await open($, surface, 'chip-cache')
    const t = text

    expect(t).toContain('Cold')
    expect(t).toContain('Next message re-reads 410k tokens')
    await ui.unmount()
  })
}

test('Compact now in the Context module compacts', async ($, on) => {
  const toasts: string[] = []

  seed(on, { reading: READING, cache: CACHE, task: TASK })
  on('session.compact', () => ({
    messages: [{ role: 'user', text: 'Summary', toolUses: [] }],
    tokensBefore: 860_000,
    tokensAfter: 90_000,
  }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const { ui } = await open($, 'desktop', 'chip-context')

  await ui.press({ key: 'popover-compact' })
  expect(toasts).toEqual(['Compacted: 860k → 90k tokens'])
  await ui.unmount()
})
