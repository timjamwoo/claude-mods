// Pure checklist logic: no engine access, so it is easy to test.
import type { Checklist, ChecklistItem, ItemStatus } from '../types'

/** One entry of a TodoWrite call, as the tool receives it. */
export type Todo = {
  content: string
  status: ItemStatus
  activeForm?: string
}

/** A change worth telling Claude about. */
export type Change =
  | { kind: 'ticked'; item: ChecklistItem }
  | { kind: 'unticked'; item: ChecklistItem }
  | { kind: 'manual-added'; item: ChecklistItem }
  | { kind: 'kept-done'; item: ChecklistItem }

export const EMPTY_CHECKLIST: Checklist = { items: [], nextId: 1 }

/**
 * Applies a TodoWrite call to the checklist.
 *
 * TodoWrite always carries the whole todo list, so todo items not in the new
 * list are dropped. Manual items are never touched. An item the person ticked
 * stays completed even when the new list says otherwise; those are returned
 * in `keptDone` so the caller can tell Claude.
 */
export function mergeTodos(
  list: Checklist,
  todos: readonly Todo[],
): { list: Checklist; keptDone: ChecklistItem[] } {
  const oldTodos = list.items.filter(item => item.source === 'todo')
  const manual = list.items.filter(item => item.source === 'manual')
  const merged: ChecklistItem[] = []
  const keptDone: ChecklistItem[] = []
  let nextId = list.nextId

  for (const todo of todos) {
    const text = todo.content.trim()
    if (text === '' || merged.some(item => item.text === text)) continue

    const existing = oldTodos.find(item => item.text === text)
    if (existing === undefined) {
      merged.push({ id: nextId, text, source: 'todo', status: todo.status, ticked: false })
      nextId += 1
    } else if (existing.ticked && todo.status !== 'completed') {
      merged.push({ ...existing, status: 'completed' })
      keptDone.push(existing)
    } else {
      merged.push({ ...existing, status: todo.status })
    }
  }

  return { list: { items: [...merged, ...manual], nextId }, keptDone }
}

/** Adds a manual step unless one with the same text already exists. */
export function addManual(
  list: Checklist,
  text: string,
): { list: Checklist; item: ChecklistItem; added: boolean } {
  const trimmed = text.trim()
  const existing = list.items.find(item => item.text === trimmed)
  if (existing !== undefined) return { list, item: existing, added: false }

  const item: ChecklistItem = {
    id: list.nextId,
    text: trimmed,
    source: 'manual',
    status: 'pending',
    ticked: false,
  }
  return { list: { items: [...list.items, item], nextId: list.nextId + 1 }, item, added: true }
}

/** Ticks an item done, or unticks it back to pending. */
export function setTicked(
  list: Checklist,
  id: number,
  ticked: boolean,
): { list: Checklist; item: ChecklistItem | undefined } {
  const found = list.items.find(item => item.id === id)
  if (found === undefined) return { list, item: undefined }

  const item: ChecklistItem = ticked
    ? { ...found, status: 'completed', ticked: true }
    : { ...found, status: 'pending', ticked: false }
  const items = list.items.map(one => (one.id === id ? item : one))
  return { list: { ...list, items }, item }
}

const MANUAL_LINE = /^\s*(?:[-*>]\s*|\d+[.)]\s*)?(?:\*\*)?MANUAL:(?:\*\*)?\s*(.+?)\s*$/

/** The texts of the lines in `text` that start with "MANUAL:", without repeats. */
export function parseManualLines(text: string): string[] {
  const found: string[] = []
  for (const line of text.split('\n')) {
    const match = MANUAL_LINE.exec(line)
    if (match === null) continue
    const step = (match[1] ?? '').replace(/\*\*$/, '').trim()
    if (step !== '' && !found.includes(step)) found.push(step)
  }
  return found
}

export function openItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter(item => item.status !== 'completed')
}

/** Parses the argument of /done: "3", "#3" or "3 " all mean item 3. */
export function parseItemId(args: string): number | undefined {
  const match = /^#?(\d+)$/.exec(args.trim())
  return match === null ? undefined : Number(match[1])
}

function quote(items: readonly ChecklistItem[]): string {
  return items.map(item => `#${item.id} "${item.text}"`).join(', ')
}

/**
 * One compact note for Claude about what changed since the last note. Only
 * the kinds of change that happened are mentioned.
 */
export function describeChanges(changes: readonly Change[]): string {
  const of = (kind: Change['kind']) => changes.filter(change => change.kind === kind).map(change => change.item)
  const ticked = of('ticked')
  const unticked = of('unticked')
  const manual = of('manual-added')
  const kept = of('kept-done')

  const parts: string[] = []
  if (ticked.length > 0) parts.push(`The user ticked these done: ${quote(ticked)}.`)
  if (kept.length > 0) {
    parts.push(`These stay done because the user ticked them, although your TodoWrite reopened them: ${quote(kept)}.`)
  }
  if (unticked.length > 0) parts.push(`The user reopened: ${quote(unticked)}.`)
  if (manual.length > 0) parts.push(`New manual steps the user will do by hand (not you): ${quote(manual)}.`)
  if (ticked.length > 0 || kept.length > 0) {
    parts.push('Do not remind the user about done items or add them back to TodoWrite.')
  }
  return `[cc-board] Checklist update. ${parts.join(' ')}`
}
