import type { GitChange } from './types'

// A snapshot maps each dirty path to "<XY status>:<content hash>". Comparing
// two snapshots finds files whose state changed in between, including a second
// edit to a file that was already modified.
export type Snapshot = { root: string; files: Record<string, string>; truncated: boolean }

export type StatusEntry = { path: string; xy: string }

export function parseStatus(out: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    entries.push({ path, xy })
  }
  return entries
}

export function buildFiles(entries: StatusEntry[], hashable: StatusEntry[], hashed: string[]): Record<string, string> {
  const hashOf = new Map<string, string>()
  hashable.forEach((e, i) => hashOf.set(e.path, hashed[i] ?? '-'))
  const files: Record<string, string> = {}
  for (const e of entries) files[e.path] = `${e.xy}:${hashOf.get(e.path) ?? '-'}`
  return files
}

export function diffSnapshots(before: Snapshot, after: Snapshot): GitChange[] {
  const out: GitChange[] = []
  for (const [path, state] of Object.entries(after.files)) {
    const was = before.files[path]
    if (was === undefined) out.push({ path, change: 'new' })
    else if (was !== state) out.push({ path, change: 'changed' })
  }
  for (const path of Object.keys(before.files)) {
    if (after.files[path] === undefined) out.push({ path, change: 'cleaned' })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
