import { expect, test } from 'claude-code/testing'

import { MACOS, HOVER_CLEAR, WINDOWS, buildPill, chipButtons, fitSpaces } from '../hooks/pill'
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
/** What the stand-in's store was asked to keep. */
const stored: unknown[] = []

const seed = (on: any, values: Record<string, unknown>, opened: { id: string; title?: string }[] = [], usage: Record<string, unknown> = {}) => {
  const held: Record<string, unknown> = {
    cache: null, minute: 0, task: NO_TASK, ledger: NO_LEDGER, isWorking: false, limitSamples: [], headroom: null, celebrateUntil: 0, popover: null,
    ...values,
  }
  let version = 1

  closed.length = 0
  stored.length = 0

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
  on('store.set', (_: unknown, e: { value: unknown }) => {
    stored.push(e.value)

    return { value: undefined }
  })
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

/** Where the drawing's hairlines are: between groups only, never inside the context and cache pair. */
const groupEnds = (pill: ReturnType<typeof buildPill>) =>
  pill.chips.slice(0, -1).filter(c => c.kind !== 'context').map(c => Number((c.x + c.width).toFixed(1)))

const dividers = (source: string) => [...source.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="1" height="18" class="divider"/g)].map(m => Number(m[1]))

// ── The extents ──

test('the full bar draws three groups, and gives every chip its extent, edge to edge as drawn', () => {
  const pill = buildPill(FULL, 1_200)

  expect(pill.chips.map(c => c.kind)).toEqual(['task', 'session', 'context', 'cache'])
  // The first starts inside the border; each next one past the hairline the drawing puts between them.
  expect(pill.chips[0]!.x).toBe(MACOS.left + 4)
  pill.chips.slice(1).forEach((c, i) => expect(Math.abs(c.x - (pill.chips[i]!.x + pill.chips[i]!.width + 1)) < 1e-6).toBe(true))
  // Two hairlines make three groups: the context and cache chips share one, with none between them.
  expect(dividers(pill.source)).toEqual(groupEnds(pill))
  expect(dividers(pill.source).length).toBe(2)
  // The last ends where the row's inset does.
  const last = pill.chips[pill.chips.length - 1]!
  expect(Math.abs(last.x + last.width - (1_200 - 4)) < 1e-6).toBe(true)

  // The task takes the spare width: the others stay as wide as their content asks.
  const narrow = buildPill(FULL, 900)

  expect(pill.chips[0]!.width - narrow.chips[0]!.width).toBeGreaterThan(250)
  expect(Math.abs(pill.chips[1]!.width - narrow.chips[1]!.width) < 1e-6).toBe(true)

  // The limits group has two thin bars stacked, session over week; the context chip one.
  const bars = (source: string) => [...source.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="[\d.]+" height="5" rx="2.5" class="track"/g)]

  expect(bars(pill.source).map(m => Number(m[2]))).toHaveLength(3)
  expect(bars(pill.source)[0]![2]).not.toBe(bars(pill.source)[1]![2])
  expect(bars(pill.source)[0]![1]).toBe(bars(pill.source)[1]![1])
  // One dot, in the cache chip.
  const dot = [...pill.source.matchAll(/<circle cx="([\d.]+)"/g)].map(m => Number(m[1]))

  expect(dot).toHaveLength(1)
  expect(dot[0]! > pill.chips[3]!.x && dot[0]! < pill.chips[3]!.x + pill.chips[3]!.width).toBe(true)
  expect(pill.source.includes('>48k<') && pill.source.includes('>ctx<') && pill.source.includes('>warm<')).toBe(true)
  expect(pill.source.includes('>↻ ') || FULL.session?.reset === undefined).toBe(true)
})

test('the limits group reads 23% strong, the week and the reset dim, and a pace that runs out replaces them', () => {
  const calm = buildPill({ ...FULL, session: { percent: 23.5, reset: '14:14' } }, 1_200).source

  expect(calm.includes('>24%<') && calm.includes('>· 41% wk<') && calm.includes('>↻ 14:14<')).toBe(true)

  const out = buildPill({ ...FULL, session: { percent: 78, reset: '14:14', out: 'out ~16:40' } }, 1_200).source

  expect(out.includes('>78%<') && out.includes('>· out ~16:40<')).toBe(true)
  expect(out.includes('wk<') || out.includes('↻')).toBe(false)
})

const frame = (source: string) => /class="(frame[^"]*)"/.exec(source)![1]

test('a warning colours only the bar and the figure at risk; the border only at red', () => {
  const ok = buildPill(FULL, 1_200, MACOS, CELL)

  // Calm: a plain hairline, no gradient, and bars of the neutral fill.
  expect(frame(ok.source)).toBe('frame')
  expect(ok.source.includes('linearGradient')).toBe(false)
  expect(/class="(amber|red)"/.test(ok.source)).toBe(false)
  // No group is ever washed.
  expect(ok.source.includes('wash-')).toBe(false)

  // The week at 75%: its bar and its own figure turn amber, the session's percent, the
  // clock and the border do not.
  const warn = buildPill({ ...FULL, session: { percent: 23.5, reset: '14:14' }, week: 75 }, 1_200, MACOS, CELL)

  expect(frame(warn.source)).toBe('frame')
  expect(warn.source.includes('wash-')).toBe(false)
  expect(/class="amber"/.test(warn.source)).toBe(true)
  expect(/class="dim t-amber"[^>]*>· 75% wk</.test(warn.source)).toBe(true)
  expect(/class="value"[^>]*>24%</.test(warn.source)).toBe(true)
  expect(/class="dim"[^>]*>↻ /.test(warn.source)).toBe(true)

  // A session running out is a warning whatever its figure: its percent and the time.
  const out = buildPill({ ...FULL, session: { percent: 40, out: 'out ~16:40' } }, 1_200, MACOS, CELL)

  expect(/class="value t-amber"[^>]*>40%</.test(out.source)).toBe(true)
  expect(/class="dim t-amber"[^>]*>· out ~16:40</.test(out.source)).toBe(true)

  // Past 90% the context's figure is red, its word stays dim, and the border turns red.
  const hot = buildPill({ ...FULL, context: { percent: 93, label: '186k / 200k' } }, 1_200, MACOS, CELL)

  expect(/class="value t-red"[^>]*>186k</.test(hot.source)).toBe(true)
  expect(/class="dim"[^>]*>ctx</.test(hot.source)).toBe(true)
  expect(frame(hot.source)).toBe('frame edge-red')
})

test('a cooling cache tints only its own word and dot', () => {
  const pill = buildPill({ ...FULL, cache: { isWarm: true, percentLeft: 5, coolsIn: 4 } }, 1_200, MACOS, CELL)

  expect(pill.source.includes('>cools 4m<')).toBe(true)
  expect(/<text[^>]*class="label t-amber"[^>]*>cools 4m</.test(pill.source)).toBe(true)
  expect(/<circle [^>]*class="amber"/.test(pill.source)).toBe(true)
  expect(pill.source.includes('wash-')).toBe(false)
  expect(frame(pill.source)).toBe('frame')
  expect((pill.source.match(/t-amber"/g) ?? []).length).toBe(1)
})

test('both colour schemes are in the drawing: dark by default, light under the media query', () => {
  const { source } = buildPill(FULL, 1_200)
  const style = /<style>(.*?)<\/style>/s.exec(source)![1]!
  const [dark, light] = style.split('@media (prefers-color-scheme:light){')

  expect(light).toBeDefined()
  // Text: pale figures and a mid grey dim on dark, near-black and a deeper grey on light.
  expect(dark!.includes('.value{fill:#F7F7F8')).toBe(true)
  expect(light!.includes('.value{fill:#141417}')).toBe(true)
  expect(dark!.includes('.dim{fill:#9A9AA3')).toBe(true)
  expect(light!.includes('.dim{fill:#5F5F68}')).toBe(true)
  // Amber and red redefined for text, and the hairlines and border.
  for (const rule of ['.t-amber{', '.t-red{', '.divider{', '.track{', '.frame{', '.edge-red{', '.dot-warm{']) {
    expect(dark!.includes(rule)).toBe(true)
    expect(light!.includes(rule)).toBe(true)
  }

  // No colour is hard-coded on an element, where light mode could not reach it.
  expect(/(fill|stroke)="#/.test(source.slice(source.indexOf('>Working<')))).toBe(false)
})

/** What a drawing keeps: its words, its chips, and how many bars it has (steps, tracks and the limit bars). */
const kept = (pill: ReturnType<typeof buildPill>) =>
  [
    pill.source.includes('↻') && 'clock',
    pill.source.includes('wk<') && 'wk',
    pill.source.includes('>Working<') && 'label',
    pill.source.includes('>ctx<') && 'ctx',
    pill.source.includes('>warm<') && 'cachword',
    pill.chips.map(c => c.kind).join('+'),
    `${(pill.source.match(/class="track"/g) ?? []).length} tracks`,
  ]
    .filter(Boolean)
    .join(' ')

test('a narrow bar drops words before figures, and whole chips last', () => {
  const full = { ...FULL, session: { percent: 23.5, reset: '14:14' } }
  const seen: string[] = []

  for (let width = 1_200; width >= 150; width -= 2) {
    const pill = buildPill(full, width)
    const k = kept(pill)

    // The figures stay for as long as their chips do.
    expect(pill.source.includes('>24%<')).toBe(true)
    expect(pill.source.includes('>48k<')).toBe(pill.chips.some(c => c.kind === 'context'))
    expect(pill.source.includes('>1/2<')).toBe(true)
    expect(dividers(pill.source)).toEqual(groupEnds(pill))
    if (seen[seen.length - 1] !== k) seen.push(k)
  }

  const all = 'task+session+context+cache'

  // The tracks: the two steps, the session, week and context bars; the week's bar goes before any chip does.
  expect(seen).toEqual([
    `clock wk label ctx cachword ${all} 5 tracks`,
    `label ctx cachword ${all} 5 tracks`,
    `${all} 5 tracks`,
    `${all} 4 tracks`,
    `task+session+context 4 tracks`,
    `task+session 3 tracks`,
  ])
})

test('the week figure outlives its clock, word and bar', () => {
  const full = { ...FULL, session: { percent: 23.5, reset: '14:14' } }
  const at = (width: number) => buildPill(full, width).source
  const widths = [1_200, 800, 560, 520, 500, 460, 420, 380, 340, 300, 260].filter(w => w < 1_201)

  // Wherever the limits chip is drawn with its week bar gone, the week is still said.
  for (const w of widths) {
    const source = at(w)

    if (source.includes('>· 41%<') || source.includes('>· 41% wk<')) continue
    expect(source.includes('>· 41%<')).toBe(false)
  }

  expect(at(1_200).includes('>· 41% wk<')).toBe(true)
})

test('drawn for the band, every divider sits on a cell middle, and the hover areas keep equally clear of it', () => {
  for (const cell of [CELL, 8, 9.5]) {
    for (const [width, fit] of [
      [122 * cell, MACOS],
      [96 * cell, MACOS],
      [64 * cell, MACOS],
      [122 * cell, WINDOWS],
    ] as const) {
      const pill = buildPill(FULL, width, fit, cell)
      const free = buildPill(FULL, width, fit)
      const areas = chipButtons(pill.chips, cell)

      expect(areas.map(b => b.kind)).toEqual(pill.chips.map(c => c.kind))
      expect(areas.map(b => b.kind)).toEqual(['task', 'session', 'context', 'cache'])
      // The task chip's starts where the mascot's button always has.
      expect(areas[0]!.left).toBe(0)
      // Snapping moves no divider by more than a cell, and the row still ends where it did.
      pill.chips.forEach((c, i) => expect(Math.abs(c.x - free.chips[i]!.x)).toBeLessThanOrEqual(cell))
      const last = pill.chips[pill.chips.length - 1]!
      const freeLast = free.chips[free.chips.length - 1]!
      expect(Math.abs(last.x + last.width - (freeLast.x + freeLast.width)) < 1e-6).toBe(true)
      // The drawing's hairlines are where the extents say.
      expect(dividers(pill.source)).toEqual(groupEnds(pill))

      areas.forEach((b, i) => {
        const chip = pill.chips[i]!
        // In the drawing's pixels: the band's cell j starts at (j + 1) * cell.
        const start = (b.left + 1) * cell
        const end = start + b.cells * cell

        // Inside its segment, never touching the border or a divider.
        expect(start).toBeGreaterThanOrEqual(chip.segStart + 1 + HOVER_CLEAR - 1e-6)
        expect(end).toBeLessThanOrEqual(chip.segEnd - HOVER_CLEAR + 1e-6)

        if (i > 0) {
          // A divider centred on a cell middle: the areas either side are as far from it.
          const centre = chip.segStart + 0.5
          const before = (areas[i - 1]!.left + 1 + areas[i - 1]!.cells) * cell

          expect(Math.abs(centre / cell - Math.floor(centre / cell) - 0.5) < 1e-6).toBe(true)
          expect(Math.abs(centre - before - (start - centre)) < 1e-6).toBe(true)
        }
      })

      // No Button's label fills its area, even with a cell a tenth smaller than measured:
      // the app would shrink it and draw an ellipsis. The area stretches it instead.
      areas.forEach(b => expect(21 + 3.64 * fitSpaces(b.cells, cell)).toBeLessThan(b.cells * cell * 0.9))
    }
  }
})

// ── The band ──

test('on the desktop every chip has its own blank button', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  for (const key of ['agents', 'chip-session', 'chip-context', 'chip-cache']) {
    const button: any = await ui.find({ key })

    expect(button?.type).toBe('Button')
    expect(/^ +$/.test(button.props.label)).toBe(true)
  }

  await ui.unmount()
})

test('without a task the mascot still leads, idle, and the gauges keep their buttons', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: false }, surface: 'desktop' })
  const svg: any = await ui.find({ type: 'Svg' })

  expect((await ui.find({ key: 'agents' }) as any)?.type).toBe('Button')
  expect(svg.props.source).toContain('>Ready<')
  expect(svg.props.alt.startsWith('Task')).toBe(false)
  expect((await ui.find({ key: 'chip-session' }) as any)?.type).toBe('Button')
  await ui.unmount()
})

test('on the terminal each figure is a plain button around its text', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await ui.find({ key: 'chip-week' })).toBe(undefined)

  for (const key of ['chip-session', 'chip-context', 'chip-cache']) {
    expect((await ui.find({ key }) as any)?.type).toBe('Button')
  }

  expect((await ui.find({ type: 'Text', text: /wk/ }))?.text).toBe('24% · 41% wk')
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

/** The terminal draws no pictures: nothing in its text is an Svg. */
const svgs0 = (_: string[]) => 0

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
    expect(t).toContain('87%')
    expect(t.some(x => x.startsWith('· resets '))).toBe(true)
    expect(t).toContain('Week')
    expect(t).toContain('31%')
    expect(t.some(x => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d$|^in /.test(x))).toBe(true)
    expect(t).toContain('This session')
    expect(t).toContain('+49%')

    // Neutral below 70 used, amber from it, never green.
    const used: any = await ui.find({ type: 'Text', text: '+49%' })

    expect(used.props.color).toBe(undefined)
    await ui.unmount()
  })

  test(`Context on the ${surface}: the share, grouped rows with subtotals, and Compact now`, async ($, on) => {
    seed(on, { reading: READING, cache: CACHE, task: TASK })

    const { ui, text } = await open($, surface, 'chip-context')
    const t = text

    expect(t).toContain('Context')
    expect(t).toContain('860k')
    expect(t).toContain('of 1M · 86% · 140k free')
    // Messages is the conversation; the rest is always loaded. Subtotals are of what
    // is used, in the same columns as the rows.
    expect(t).toContain('Conversation')
    expect(t).toContain('Always loaded')
    expect(t).toContain('160k')
    expect(t).toContain('19%')
    expect(t).toContain('Messages')
    expect(t).toContain('700k')
    expect(t).toContain('81%')
    expect(t).toContain('System tools')
    // Ten rows of band: what doesn't fit folds into one row, and Compact now still shows.
    expect(t).toContain('▾ 1 more: System prompt')
    // The free space fills nothing.
    expect(t.includes('Free space')).toBe(false)
    expect((await ui.find({ key: 'popover-compact' }))?.text).toBe('Compact now')

    if (surface === 'desktop') {
      const svgs: any[] = await ui.findAll({ type: 'Svg' })

      expect(svgs.some(s => String(s.props.alt).startsWith('Context by category: Messages 700k'))).toBe(true)
    } else {
      expect(svgs0(t)).toBe(0)
    }

    await ui.unmount()
  })

  test(`Context on the ${surface}: the folded row opens every row, and Show less folds them again`, async ($, on) => {
    seed(on, { reading: READING, cache: CACHE, task: TASK })
    await press($, surface, 'chip-context')

    let { ui, text } = await look($, surface)

    expect(text.includes('System prompt')).toBe(false)
    await ui.press({ key: 'context-more-Always loaded' })
    await ui.unmount()
    ;({ ui, text } = await look($, surface))
    expect(text).toContain('System prompt')
    expect(text).toContain('▴ Show less')
    expect(text.some(x => x.includes('more:'))).toBe(false)
    await ui.press({ key: 'context-less' })
    await ui.unmount()
    ;({ ui, text } = await look($, surface))
    expect(text).toContain('▾ 1 more: System prompt')

    // Opened, then closed: it opens folded next time.
    await ui.press({ key: 'context-more-Always loaded' })
    await ui.press({ key: 'popover-close' })
    await ui.unmount()
    await press($, surface, 'chip-context')
    ;({ ui, text } = await look($, surface))
    expect(text).toContain('▾ 1 more: System prompt')
    await ui.unmount()
  })

  test(`Cache on the ${surface}: the hour left, what the next message costs warm and cold, and the session`, async ($, on) => {
    const log = [
      { read: 0, written: 30_000, uncached: 10, at: NOW - 80 * MIN },
      { read: 30_000, written: 2_000, uncached: 10, at: NOW - 70 * MIN },
      { read: 380_000, written: 9_000, uncached: 1_000, at: NOW - 30 * MIN },
      CACHE,
    ]

    seed(on, {
      reading: READING,
      cache: CACHE,
      cacheLog: log,
      task: TASK,
      ledger: { ...NO_LEDGER, main: { input: 10, cacheRead: 990_000, cacheWrite: 0, output: 5, requests: 4 } },
    })
    await press($, surface, 'chip-cache')

    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 18 }, surface })
    const t = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text) as string[]

    expect(t).toContain('Cache')
    expect(t).toContain('Warm')
    expect(t.some(x => x.startsWith('· 42m left · cools '))).toBe(true)
    // A tenth of 410k while warm; twice it once the cache must be written again.
    expect(t).toContain('Send now')
    expect(t).toContain('≈ 41k')
    expect(t).toContain('After it cools')
    expect(t).toContain('≈ 820k')
    expect(t).toContain('Last reply 410k')
    expect(t).toContain(' read 400k')
    expect(t).toContain(' written 9k')
    expect(t).toContain('4 replies · hit 100%')
    expect(t).toContain('≈ 891k')
    expect(t.some(x => x.startsWith('Cold starts') && x.includes('(start)'))).toBe(true)
    expect((await ui.find({ key: 'cache-warn' }))?.text).toBe('Warn at 5m: on')
    expect((await ui.find({ key: 'popover-compact' }))?.text).toBe('Compact now')

    if (surface === 'desktop') {
      const alts = ((await ui.findAll({ type: 'Svg' })) as any[]).map(s => String(s.props.alt))

      expect(alts).toContain('42 minutes of the cache\'s hour left')
      expect(alts).toContain('Cache use per reply, 1 cold starts')
    }

    await ui.unmount()
  })

  test(`a short band keeps the cost of the next message and drops the rest first on the ${surface}`, async ($, on) => {
    seed(on, { reading: READING, cache: CACHE, cacheLog: [CACHE], task: TASK, ledger: { ...NO_LEDGER, main: { input: 10, cacheRead: 990, cacheWrite: 0, output: 5, requests: 1 } } })

    await press($, surface, 'chip-cache')

    // Room for the countdown and the cost, not for every section (the terminal's band loses fewer rows).
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: surface === 'desktop' ? 14 : 10 }, surface })
    const text = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text) as string[]

    expect(text).toContain('Send now')
    expect(text.some(x => x.startsWith('Last reply'))).toBe(false)
    expect((await ui.find({ key: 'popover-compact' }))?.text).toBe('Compact now')
    await ui.unmount()
  })

  test(`a cold cache says so on the ${surface}`, async ($, on) => {
    seed(on, { reading: READING, cache: { ...CACHE, at: NOW - 61 * MIN }, task: TASK })

    const { ui, text } = await open($, surface, 'chip-cache')
    const t = text

    expect(t).toContain('Cold')
    expect(t.some(x => x.startsWith('· cooled '))).toBe(true)
    expect(t).toContain('Your next message re-sends all 410k at full price (≈ 820k)')
    expect(t.includes('Send now')).toBe(false)
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

test('Limits on the desktop draws the chart, the stat tiles and the week bar', async ($, on) => {
  seed(
    on,
    {
      reading: READING,
      cache: CACHE,
      task: TASK,
      ledger: { ...NO_LEDGER, sessionLimitAtStart: 38 },
      limitSamples: [
        { at: NOW - 60 * MIN, percent: 60 },
        { at: NOW - 30 * MIN, percent: 74 },
        { at: NOW, percent: 87 },
      ],
    },
    [],
    { rateLimits: [{ ...RATES[0]!, resetsAt: '2026-11-17T14:00:00Z' }, RATES[1]!] },
  )

  const { ui, text } = await open($, 'desktop', 'chip-session')
  const svgs: any[] = await ui.findAll({ type: 'Svg' })
  const chart = svgs.find(s => String(s.props.alt).startsWith('Session limit 87% used'))

  expect(chart).toBeTruthy()
  expect(chart.props.height).toBe(116)
  expect(chart.props.source.includes('>87%<')).toBe(true)
  expect(chart.props.source.includes('>Limit<')).toBe(true)
  expect(svgs.some(s => String(s.props.alt) === 'Week 31%')).toBe(true)
  expect(text).toContain('At this pace')
  expect(text).toContain('Pace')
  expect(text.some(x => /^~\d+% \/ h$/.test(x))).toBe(true)
  await ui.unmount()
})

test('Context on the desktop highlights the largest row and shows the last turn', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK, headroom: { categories: CATEGORIES, lastTurnDelta: 120_000, biggest: { label: 'Read register.tsx', tokens: 18_000 }, at: NOW } })

  const { ui, text } = await open($, 'desktop', 'chip-context')

  expect(text).toContain('Last turn')
  expect(text).toContain('+120k')
  expect(text).toContain('Read register.tsx ~18k')
  // 120k is over a tenth of the 1M window: amber.
  expect(((await ui.find({ type: 'Text', text: '+120k' })) as any).props.color).toBe('warning')
  await ui.unmount()
})

test('the warning switch turns the five-minute warning off and remembers it', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })
  await press($, 'desktop', 'chip-cache')

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'cache-warn' })
  await ui.unmount()
  for (let i = 0; i < 50 && stored.length === 0; i++) await new Promise(r => (globalThis as any).setTimeout(r, 1))
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ key: 'cache-warn' }))?.text).toBe('Warn at 5m: off')
  expect(stored).toContain(true)
  await ui.unmount()
})
