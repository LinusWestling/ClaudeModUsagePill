import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { AgentRun, ChangedFile, Hunk } from '../types'
import { NEUTRAL, inLight } from './scheme'
import {
  FILE_TOOLS,
  YOU,
  actorsOf,
  addEdit,
  changeOf,
  filtered,
  hunksOfChange,
  relativeTo,
  unified,
} from './filediff'
import type { Change } from './filediff'

const changedFiles = atom({ plugin: 'usage-pill', key: 'changedFiles' } as const, [], { shape: 'files-1' })
const filesOpen = atom({ plugin: 'usage-pill', key: 'filesOpen' } as const, [])
const filesFilter = atom({ plugin: 'usage-pill', key: 'filesFilter' } as const, 'all')

// The same declaration as register.tsx's: one value, read from two places.
const agents = atom({ plugin: 'usage-pill', key: 'agents' } as const, [], { shape: 'agents-1' })

/** Hunks shown on an opened row before the rest fold behind a count. */
export const SHOWN_HUNKS = 2

/** What a card is titled, so a file edited by an agent names it the same way. */
const titleOf = (run: AgentRun | undefined) => run?.description || run?.type || 'Subagent'

/** The key under which a row's folded hunks are opened, kept beside its own in the open list. */
const moreKey = (path: string) => `more:${path}`

const toggle = (keys: readonly string[], key: string): string[] =>
  keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key].slice(-200)

/** The five-block bar: how much of a file's change was added (green) and how much removed (red). */
export const ratioSvg = (added: number, removed: number): { source: string; alt: string } => {
  const total = added + removed
  let green = total === 0 ? 0 : Math.round((5 * added) / total)

  // A side that is there keeps at least a block, whatever the proportion.
  if (added > 0 && green === 0) green = 1
  if (removed > 0 && green === 5) green = 4

  const red = total === 0 ? 0 : 5 - green
  const blocks = Array.from({ length: 5 }, (_, i) => {
    const kind = i < green ? 'a' : i < green + red ? 'r' : 'n'

    return `<rect class="${kind}" x="${i * 7}" y="0" width="6" height="10" rx="1"/>`
  }).join('')

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="10" viewBox="0 0 34 10">` +
    `<style>.a{fill:#3fb950}.r{fill:#f85149}.n{fill:${NEUTRAL(0.35)}}${inLight('.a{fill:#1a7f37}.r{fill:#cf222e}')}</style>` +
    `${blocks}</svg>`

  return { source, alt: `${added} added, ${removed} removed` }
}

/** `src/` and `app.ts` of `src/app.ts`: the directory read dim and the name at full strength. */
export const splitPath = (path: string): { dir: string; name: string } => {
  const at = path.lastIndexOf('/')

  return at < 0 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The Changed files section of the Subagents pane: a header with the totals, the
 * filter, and a row a file, opened to its diff. Nothing while no file has been
 * edited, so a session that changed none shows no trace of it.
 */
export async function filesSection($: EngineInterface, e: RenderInput<'Pane'>) {
  const all = await read($, changedFiles)

  if (all.length === 0) return null

  const open = await read($, filesOpen)
  const who = await read($, filesFilter)
  const runs = await read($, agents)
  const cwd = await $.session.cwd().catch(() => '')
  const { Box, Button, Code, Text } = $.ui.resolve(e)
  const hasPictures = e.surface !== 'terminal'

  const nameOf = (id: string | null) => (id === null ? 'you' : titleOf(runs.find(r => r.id === id)))
  const actors = actorsOf(all)
  // A filter whose actor has nothing (gone with a cleared list) falls back to everyone.
  const key = who === 'all' || who === YOU || actors.includes(who) ? who : 'all'
  const files = filtered(all, key)
  const totals = files.reduce((sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }), {
    added: 0,
    removed: 0,
  })

  const counts = (added: number, removed: number) => (
    <Text tabular>
      <Text color="success">{`+${added}`}</Text> <Text color="error">{`−${removed}`}</Text>
    </Text>
  )

  // Quiet text tabs like Cards and Timeline: the one on show at full strength.
  const tab = (id: string, label: string) => (
    <Button
      key={`files-filter-${id}`}
      plain
      dimColor={key !== id}
      label={label}
      onPress={() => void update($, filesFilter, () => id)}
    />
  )

  const picture = (file: ChangedFile) => {
    const { Svg } = $.ui.resolve(e as RenderInput & { surface: 'desktop' })
    const bar = ratioSvg(file.added, file.removed)

    return <Svg key={`files-bar-${file.path}`} source={bar.source} alt={bar.alt} width={34} height={10} />
  }

  const hunk = (file: ChangedFile, part: Hunk, i: number) => (
    <Box key={`files-hunk-${file.path}-${i}`} flexDirection="column">
      <Text dimColor size="caption">{`@@ ${part.newStart}`}</Text>
      <Code source={unified([part])} format="diff" path={file.path} />
    </Box>
  )

  const diff = (file: ChangedFile) => {
    const more = open.includes(moreKey(file.path))
    const shown = more ? file.hunks : file.hunks.slice(0, SHOWN_HUNKS)
    const folded = file.hunks.length - shown.length
    const by = file.editors.map(x => nameOf(x.by)).join(', ')

    return (
      <Box key={`files-diff-${file.path}`} flexDirection="column" rowGap={1} paddingLeft={2}>
        {file.hunks.length === 0 ? <Text dimColor>No lines changed.</Text> : shown.map((part, i) => hunk(file, part, i))}
        {folded > 0 || (more && file.hunks.length > SHOWN_HUNKS) ? (
          <Button
            key={`files-more-${file.path}`}
            plain
            dimColor
            label={more ? 'Show fewer hunks' : plural(folded, 'more hunk', 'more hunks')}
            onPress={() => void update($, filesOpen, keys => toggle(keys, moreKey(file.path)))}
          />
        ) : null}
        {file.cut > 0 ? <Text dimColor size="caption">{`${plural(file.cut, 'diff line', 'diff lines')} left out`}</Text> : null}
        <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor size="caption" wrap="truncate-end">
              {`by ${by} · ${plural(file.edits, 'edit', 'edits')}`}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Button
              key={`files-copy-${file.path}`}
              label="Copy path"
              onPress={async press => {
                const copied = await $.ui.copy({ text: file.path, surface: press.surface })

                $.ui.toast(copied.isCopied ? 'Path copied' : 'This app can’t copy from a mod yet')
              }}
            />
          </Box>
        </Box>
      </Box>
    )
  }

  const row = (file: ChangedFile) => {
    const isOpen = open.includes(file.path)
    const { dir, name } = splitPath(relativeTo(file.path, cwd))
    const agentsHere = file.editors.filter(x => x.by !== null).map(x => nameOf(x.by))
    const by = agentsHere.length === 0 ? '' : agentsHere.length === 1 ? agentsHere[0] : `${agentsHere[0]} +${agentsHere.length - 1}`

    return (
      <Box key={`files-row-${file.path}`} flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
          <Box flexShrink={1} minWidth={0}>
            <Button
              key={`file-${file.path}`}
              plain
              label={relativeTo(file.path, cwd)}
              onPress={() => void update($, filesOpen, keys => toggle(keys, file.path))}
            >
              {isOpen ? '▾' : '▸'} <Text color={file.status === 'A' ? 'success' : 'warning'}>{file.status}</Text>{' '}
              <Text dimColor>{dir}</Text>
              {name}
              {by === '' ? '' : <Text dimColor>{` · ${by}`}</Text>}
            </Button>
          </Box>
          <Box flexShrink={0} flexDirection="row" columnGap={1} alignItems="center">
            {counts(file.added, file.removed)}
            {hasPictures ? picture(file) : null}
          </Box>
        </Box>
        {isOpen ? diff(file) : null}
      </Box>
    )
  }

  return (
    <Box key="files" flexDirection="column" rowGap={1}>
      <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
        <Text bold>{`Changed files · ${files.length}`}</Text>
        {counts(totals.added, totals.removed)}
      </Box>
      <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" columnGap={1} flexShrink={1} minWidth={0}>
          {tab('all', 'All')}
          {tab(YOU, 'You')}
          {actors.filter((x): x is string => x !== null).map(id => tab(id, nameOf(id)))}
        </Box>
        <Box flexShrink={0}>
          <Button key="files-collapse" plain dimColor label="Collapse all" onPress={() => void update($, filesOpen, () => [])} />
        </Box>
      </Box>
      {files.length === 0 ? <Text dimColor>No files edited by this one.</Text> : files.map(row)}
    </Box>
  )
}

// ── Reading and recording ──

const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/** What a file held ahead of a call: its text, or undefined when it isn't there or can't be read. */
const readBefore = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    if (!(await $.fs.exists(path))) return undefined

    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

export const registerFiles = (on: Parameters<Register>[0]) => {
  // The edits that went through, as the list of changed files. It reads and notes
  // around the call, and never fails or changes it. MultiEdit is no tool of this
  // build's table, hence the cast: a matcher for a name no call carries stays idle.
  for (const tool of FILE_TOOLS) {
    on('tool.call', { tool: tool as 'Edit' }, async ($, e, next) => {
      const args = e as unknown as Record<string, unknown>
      let change: Change | undefined
      let before: string | undefined
      let path = ''

      try {
        change = changeOf(args)

        if (change) {
          const cwd = await $.session.cwd()

          path = isAbsolute(change.path) ? change.path : `${cwd.replace(/\/$/, '')}/${change.path}`
          before = await readBefore($, path)
        }
      } catch {
        change = undefined
      }

      const result = await next(e)

      try {
        if (change && result.isError !== true && result.deny === undefined) {
          const by = typeof args.agentId === 'string' ? args.agentId : null
          const made = hunksOfChange(change, before, by)

          await update($, changedFiles, list => addEdit(list, path, by, made))
        }
      } catch {
        // The edit is made; only its note is lost.
      }

      return result
    }).catch(($, e, next) => next(e))
  }
}
