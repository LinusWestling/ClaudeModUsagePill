import { expect, test } from 'claude-code/testing'

import {
  MAX_DIFF_LINES,
  addEdit,
  agentsInTranscript,
  capHunks,
  changesInTranscript,
  changeOf,
  filtered,
  headerOf,
  hunksOf,
  hunksOfChange,
  placeHunks,
  relativeTo,
  unified,
} from '../hooks/filediff'
import { ratioSvg, splitPath } from '../hooks/files'

const NOW = Date.parse('2026-11-04T12:00:00Z')

const PANE = {
  plugin: 'usage-pill',
  component: 'Pane',
  requestId: 'usage-pill-agents',
  props: {
    title: 'Subagents',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

// ── The diff ──

test('a diff names the lines added and removed, at their real line numbers, with context', () => {
  const before = lines(20)
  const after = before.replace('line 10\n', 'ten\nand a half\n')
  const [hunk, ...rest] = hunksOf(before, after, null)

  expect(rest).toEqual([])
  expect(hunk?.oldStart).toBe(7)
  expect(hunk?.newStart).toBe(7)
  expect(hunk?.lines).toEqual([
    ' line 7', ' line 8', ' line 9', '-line 10', '+ten', '+and a half', ' line 11', ' line 12', ' line 13',
  ])
  expect(headerOf(hunk!)).toBe('@@ -7,7 +7,8 @@')
})

test('changes far apart are separate hunks, and near ones merge', () => {
  const before = lines(40)
  const far = before.replace('line 3\n', 'a\n').replace('line 35\n', 'b\n')
  const near = before.replace('line 3\n', 'a\n').replace('line 8\n', 'b\n')

  expect(hunksOf(before, far, null).map(h => h.oldStart)).toEqual([1, 32])
  expect(hunksOf(before, near, null).length).toBe(1)
})

test('identical texts have no hunks, and a new file is one hunk of added lines', () => {
  expect(hunksOf('a\nb\n', 'a\nb\n', null)).toEqual([])

  const [hunk] = hunksOf('', 'x\ny\n', null)

  expect(hunk?.lines).toEqual(['+x', '+y'])
  expect(headerOf(hunk!)).toBe('@@ -0,0 +1,2 @@')
})

test('the diff picks the shortest edit, not just the first match', () => {
  const [hunk] = hunksOf('a\nb\nc\nd\n', 'b\nc\nd\ne\n', null)

  expect(hunk?.lines).toEqual(['-a', ' b', ' c', ' d', '+e'])
})

test('hunks print as unified text, one header each', () => {
  const hunks = hunksOf(lines(30), lines(30).replace('line 2\n', 'two\n').replace('line 28\n', 'x\n'), null)

  expect(unified(hunks).split('\n').filter(l => l.startsWith('@@')).length).toBe(2)
})

test('an edit is placed at the real line of the file when it was read, and numbered within itself when not', () => {
  const change = changeOf({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'line 15', new_string: 'fifteen' })!
  const placed = hunksOfChange(change, lines(30), null)
  const alone = hunksOfChange(change, undefined, null)

  expect(placed.hunks[0]?.oldStart).toBe(12)
  expect(alone.hunks[0]?.oldStart).toBe(1)
  expect(alone.hunks[0]?.lines).toEqual(['-line 15', '+fifteen'])
  // An edit whose text isn't in the file as read still has a diff of its own.
  expect(hunksOfChange(change, 'other\n', null).hunks[0]?.lines).toEqual(['-line 15', '+fifteen'])
})

test('a MultiEdit applies its edits one after the other, and a replace_all changes every match', () => {
  const multi = changeOf({
    tool: 'MultiEdit',
    file_path: '/repo/a.ts',
    edits: [
      { old_string: 'line 2', new_string: 'two' },
      { old_string: 'two', new_string: 'deux' },
    ],
  })!
  const all = changeOf({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y', replace_all: true })!

  expect(hunksOfChange(multi, lines(5), null).hunks[0]?.lines).toContain('+deux')
  expect(hunksOfChange(all, 'x\nx\nx\n', null).hunks[0]?.lines).toEqual(['-x', '-x', '-x', '+y', '+y', '+y'])
})

test('a Write to a file that did not exist is an addition, over one that did a modification', () => {
  const write = changeOf({ tool: 'Write', file_path: '/repo/n.ts', content: 'a\nb\n' })!

  expect(hunksOfChange(write, undefined, null).isNew).toBe(true)
  expect(hunksOfChange(write, 'a\n', null)).toMatchObject({ isNew: false, hunks: [{ lines: [' a', '+b'] }] })
})

test('a notebook edit is a diff of the cell', () => {
  const book = JSON.stringify({ cells: [{ id: 'c1', source: ['x = 1\n', 'y = 2'] }] })
  const edit = changeOf({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', cell_id: 'c1', new_source: 'x = 1\ny = 3' })!

  expect(hunksOfChange(edit, book, null).hunks[0]?.lines).toEqual([' x = 1', '-y = 2', '+y = 3'])
  expect(changeOf({ tool: 'Read', file_path: '/repo/a.ts' })).toBe(undefined)
})

test('a huge diff is cut to its cap and says how much', () => {
  const [hunk] = hunksOf('', lines(1000), null)
  const { hunks, cut } = capHunks([hunk!], 0)

  expect(hunks[0]?.lines.length).toBe(MAX_DIFF_LINES)
  expect(cut).toBe(1000 - MAX_DIFF_LINES)
})

// ── The list ──

const made = (before: string, after: string, by: string | null = null, isNew = false) => ({
  hunks: hunksOf(before, after, by),
  isNew,
})

test('edits of one file add up under one row, the latest edited file first', () => {
  let list = addEdit([], '/repo/a.ts', null, made('a\n', 'b\n'))

  list = addEdit(list, '/repo/b.ts', null, made('', 'x\ny\n', null, true))
  list = addEdit(list, '/repo/a.ts', null, made('b\nc\n', 'b\nc\nd\ne\n'))

  expect(list.map(f => f.path)).toEqual(['/repo/a.ts', '/repo/b.ts'])
  expect(list[0]).toMatchObject({ status: 'M', added: 3, removed: 1, edits: 2 })
  expect(list[0]?.hunks.length).toBe(2)
  expect(list[1]).toMatchObject({ status: 'A', added: 2, removed: 0 })
  // A file made here stays added however many edits follow.
  expect(addEdit(list, '/repo/b.ts', null, made('x\n', 'z\n'))[0]?.status).toBe('A')
})

test('the list keeps 200 files, dropping the one edited longest ago', () => {
  let list: ReturnType<typeof addEdit> = []

  for (let i = 0; i < 205; i++) list = addEdit(list, `/repo/f${i}.ts`, null, made('a\n', 'b\n'))

  expect(list.length).toBe(200)
  expect(list[0]?.path).toBe('/repo/f204.ts')
  expect(list.some(f => f.path === '/repo/f0.ts')).toBe(false)
})

test('the filter keeps a file each actor edited, with only that actor’s share', () => {
  let list = addEdit([], '/repo/a.ts', null, made('a\n', 'b\n'))

  list = addEdit(list, '/repo/a.ts', 'ag1', made('b\n', 'b\nc\nd\n', 'ag1'))
  list = addEdit(list, '/repo/z.ts', 'ag1', made('', 'q\n', 'ag1', true))

  expect(filtered(list, 'all').length).toBe(2)
  expect(filtered(list, 'you').map(f => [f.path, f.added, f.removed, f.edits])).toEqual([['/repo/a.ts', 1, 1, 1]])
  expect(filtered(list, 'ag1').map(f => [f.path, f.added, f.hunks.length])).toEqual([
    ['/repo/z.ts', 1, 1],
    ['/repo/a.ts', 2, 1],
  ])
})

test('paths read from the session directory, and the name apart from its directory', () => {
  expect(relativeTo('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  expect(relativeTo('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts')
  expect(splitPath('src/a.ts')).toEqual({ dir: 'src/', name: 'a.ts' })
  expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' })
})

test('the ratio bar is five blocks that read in both colour schemes', () => {
  const { source } = ratioSvg(9, 1)

  expect(source.match(/<rect/g)?.length).toBe(5)
  expect(source).toContain('prefers-color-scheme:light')
  expect(source.match(/class="a"/g)?.length).toBe(4)
  expect(source.match(/class="r"/g)?.length).toBe(1)
  // A side that is there keeps a block however small.
  expect(ratioSvg(1, 99).source.match(/class="a"/g)?.length).toBe(1)
  expect(ratioSvg(0, 0).source.match(/class="n"/g)?.length).toBe(5)
})

// ── Through the hook and the pane ──

type Stand = { files: Record<string, string>; fail: Set<string>; deny?: boolean; unreadable?: boolean }

const standIn = (on: any, stand: Stand = { files: {}, fail: new Set() }) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_: unknown, e: { path: string }) => {
    if (stand.unreadable) throw new Error('no access')

    return { value: e.path in stand.files }
  })
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: stand.files[e.path] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', (_: unknown, e: { tool_use_id: string }) => ({ model: 'claude-haiku-5-5', agentId: e.tool_use_id }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  // A call fails as its file is named in `fail`.
  on('tool.call', (_: unknown, e: any) =>
    stand.deny
      ? { deny: 'not allowed' }
      : stand.fail.has(e.file_path ?? '')
        ? { isError: true, result: 'no', text: 'no' }
        : { result: {} },
  )

  return stand
}

const SPAWN = {
  tool_use_id: 'call-1',
  prompt: 'Fix it',
  description: 'Fix the bug',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

const edit = (file: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  ({ tool: 'Edit', tool_use_id: `u-${file}-${from}`, file_path: file, old_string: from, new_string: to, ...extra }) as any

const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))].map((t: any) => t.text as string)

test('until a file has been edited the section is its heading and one quiet line', async ($, on) => {
  standIn(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /No files edited in this session yet/ })).not.toBe(undefined)
  expect(await ui.find({ key: 'files-collapse' })).toBe(undefined)
  await ui.unmount()
})

test('edits from you and from an agent are counted, with the totals and the filter', async ($, on) => {
  standIn(on, { files: { '/repo/src/a.ts': lines(10) }, fail: new Set() })
  await $.agent.spawn(SPAWN as any)

  await $.tool.call(edit('/repo/src/a.ts', 'line 5', 'five'))
  await $.tool.call(edit('/repo/src/a.ts', 'line 6', 'six\nsix and more', { agentId: 'call-1', tool_use_id: 'u2' }))
  await $.tool.call({ tool: 'Write', tool_use_id: 'u3', file_path: '/repo/docs/new.md', content: '# hi\n' } as any)

  for (const surface of ['desktop', 'terminal'] as const) {
    let ui = await $.ui.mount({ ...PANE, surface })
    const text = await texts(ui)
    const rowOf = async (path: string) => (await ui.find({ key: `file-${path}` }))?.text

    expect(text).toContain('Changed files · 2')
    // The latest edited file first, the new one marked A; the agent follows the name of the file it edited.
    expect(await rowOf('/repo/docs/new.md')).toBe('▸ A docs/new.md')
    expect(await rowOf('/repo/src/a.ts')).toBe('▸ M src/a.ts · Fix the bug')
    expect((await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k.startsWith('file-'))).toEqual([
      'file-/repo/docs/new.md',
      'file-/repo/src/a.ts',
    ])
    // a.ts: five and six replace two lines with three; new.md adds one: +4 −2 in all.
    expect(text).toContain('+4 −2')
    expect(((await ui.findAll({ type: 'Svg' })) as any[]).some(s => /added/.test(s.props.alt))).toBe(surface === 'desktop')

    for (const key of ['files-filter-all', 'files-filter-you', 'files-filter-call-1']) {
      expect(await ui.find({ key })).not.toBe(undefined)
    }

    expect((await ui.find({ key: 'files-filter-call-1' }))?.text).toBe('Fix the bug')
    await ui.press({ key: 'files-filter-call-1' })
    await ui.unmount()

    ui = await $.ui.mount({ ...PANE, surface })

    const only = await texts(ui)

    expect(only).toContain('Changed files · 1')
    expect(only).toContain('+2 −1')
    expect(await ui.find({ key: 'file-/repo/docs/new.md' })).toBe(undefined)
    await ui.press({ key: 'files-filter-you' })
    await ui.unmount()

    ui = await $.ui.mount({ ...PANE, surface })
    expect(await texts(ui)).toContain('Changed files · 2')
    expect(await rowOf('/repo/src/a.ts')).toBe('▸ M src/a.ts · Fix the bug')
    await ui.press({ key: 'files-filter-all' })
    await ui.unmount()
  }
})

test('a failed edit, or one the engine denied, is not counted and still fails as it did', async ($, on) => {
  const stand = standIn(on, { files: { '/repo/a.ts': 'x\n' }, fail: new Set(['/repo/bad.ts']) })

  const failed = await $.tool.call(edit('/repo/bad.ts', 'x', 'y'))

  expect((failed as any).isError).toBe(true)

  stand.deny = true

  const denied = await $.tool.call(edit('/repo/a.ts', 'x', 'y'))

  expect((denied as any).deny).toBe('not allowed')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /No files edited in this session yet/ })).not.toBe(undefined)
  await ui.unmount()
})

test('a file that cannot be read before the edit still gets a diff, and the call goes through', async ($, on) => {
  standIn(on, { files: {}, fail: new Set(), unreadable: true })

  const result = await $.tool.call(edit('/repo/a.ts', 'old', 'new'))

  expect((result as any).result).toEqual({})

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await texts(ui)).toContain('Changed files · 1')
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`on the ${surface} a row opens to its diff, folds the hunks past the second, and copies the path`, async ($, on) => {
    const copied: string[] = []

    standIn(on, { files: { '/repo/big.ts': lines(100) }, fail: new Set() })
    on('ui.copy', (_: unknown, e: { text: string }) => {
      copied.push(e.text)

      return { value: { isCopied: true } }
    })

    // Four edits far apart: four hunks.
    for (const n of [5, 30, 55, 80]) await $.tool.call(edit('/repo/big.ts', `line ${n}\n`, `changed ${n}\n`, { tool_use_id: `e${n}` }))

    let ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Code' })).toBe(undefined)
    expect(await texts(ui)).toContain('▸ M big.ts')
    await ui.press({ key: 'file-/repo/big.ts' })
    await ui.unmount()

    ui = await $.ui.mount({ ...PANE, surface })

    const codes = (await ui.findAll({ type: 'Code' })) as any[]

    expect(await texts(ui)).toContain('▾ M big.ts')
    expect(codes.length).toBe(2)
    expect(codes[0].props.format).toBe('diff')
    expect(codes[0].props.source).toContain('+changed 80')
    expect(codes[0].props.source).toContain('-line 80')
    expect((await texts(ui)).filter(t => t.startsWith('@@ ')).length).toBe(2)
    expect((await ui.find({ key: 'files-more-/repo/big.ts' }))?.text).toBe('2 more hunks')
    expect(await texts(ui)).toContain('by you · 4 edits')
    // No call opens a file in the editor, so no button pretends to.
    expect(await ui.find({ type: 'Button', text: /Open in editor/ })).toBe(undefined)

    await ui.press({ key: 'files-copy-/repo/big.ts' })
    expect(copied).toEqual(['/repo/big.ts'])
    await ui.press({ key: 'files-more-/repo/big.ts' })
    await ui.unmount()

    ui = await $.ui.mount({ ...PANE, surface })
    expect(((await ui.findAll({ type: 'Code' })) as any[]).length).toBe(4)
    await ui.press({ key: 'files-collapse' })
    await ui.unmount()

    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Code' })).toBe(undefined)
    expect(await texts(ui)).toContain('▸ M big.ts')
    await ui.unmount()
  })
}

// ── Read back from a transcript ──

const TRANSCRIPT = [
  { role: 'user', content: 'fix it' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'one', new_string: 'two' } },
      { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/repo/new.md', content: 'hi\n' } },
      { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/b.ts', old_string: 'x', new_string: 'y' } },
      { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/repo/c.ts' } },
      { type: 'tool_use', id: 't5', name: 'Agent', input: { description: 'Build the pill', prompt: '…' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'The file /repo/a.ts has been updated.' },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'File created successfully at: /repo/new.md' }] },
      { type: 'tool_result', tool_use_id: 't3', content: 'String not found', is_error: true },
      { type: 'tool_result', tool_use_id: 't4', content: 'contents' },
      { type: 'tool_result', tool_use_id: 't5', content: 'Async agent launched. agentId: a43603b5 (internal)' },
    ],
  },
]

test('a transcript gives back the file edits that went through, oldest first, and no reads', () => {
  const found = changesInTranscript(TRANSCRIPT)

  expect(found.map(f => f.change.path)).toEqual(['/repo/a.ts', '/repo/new.md'])
  expect(found[1]!.result).toContain('created')
})

test('a transcript names the agents it started, by the id their result gives', () => {
  expect(agentsInTranscript(TRANSCRIPT)).toEqual([{ id: 'a43603b5', name: 'Build the pill' }])
})

test('hunks read back are moved to where their new lines now stand in the file', () => {
  const hunks = hunksOf('one', 'two', null)
  const placed = placeHunks(hunks, 'a\nb\nc\ntwo\nd', 'two')

  expect(placed[0]!.newStart).toBe(hunks[0]!.newStart + 3)
  expect(placeHunks(hunks, 'nothing here', 'two')).toEqual(hunks)
  expect(placeHunks(hunks, undefined, 'two')).toEqual(hunks)
})
