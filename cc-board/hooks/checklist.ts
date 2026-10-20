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

/** What the Task tools tell the checklist: a task was made, or one changed. */
export type TaskEvent =
  | { kind: 'created'; taskId: string; subject: string }
  | { kind: 'updated'; taskId: string; status?: ItemStatus | 'deleted'; subject?: string }

/**
 * Applies one TaskCreate or TaskUpdate to the checklist. A task the person
 * ticked stays completed when an update reopens it, reported in `keptDone`.
 * An update for a task the checklist never saw is ignored.
 */
export function applyTaskEvent(list: Checklist, event: TaskEvent): { list: Checklist; item?: ChecklistItem; keptDone?: ChecklistItem } {
  if (event.kind === 'created') {
    const subject = event.subject.trim()
    const known = list.items.find(item => item.taskId === event.taskId)
    if (known !== undefined) return { list, item: known }
    const sameText = list.items.find(item => item.source === 'todo' && item.taskId === undefined && item.text === subject)
    if (sameText !== undefined) {
      const item = { ...sameText, taskId: event.taskId }
      return { list: { ...list, items: list.items.map(one => (one === sameText ? item : one)) }, item }
    }
    const item: ChecklistItem = { id: list.nextId, text: subject, source: 'todo', status: 'pending', ticked: false, taskId: event.taskId }
    return { list: { items: [...list.items, item], nextId: list.nextId + 1 }, item }
  }

  const found = list.items.find(item => item.taskId === event.taskId)
  if (found === undefined) return { list }
  if (event.status === 'deleted') return { list: { ...list, items: list.items.filter(item => item !== found) }, item: found }

  let item: ChecklistItem = { ...found }
  if (event.subject !== undefined && event.subject.trim() !== '') item.text = event.subject.trim()
  let keptDone: ChecklistItem | undefined
  if (event.status !== undefined) {
    if (found.ticked && event.status !== 'completed') keptDone = found
    else item.status = event.status
  }
  return { list: { ...list, items: list.items.map(one => (one === found ? item : one)) }, item, keptDone }
}

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

/** The part of a transcript message the seed needs; `$.session.messages()` rows fit it. */
export type TranscriptMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; result?: unknown; agentId?: string }[]
}

function parseTodo(value: unknown): Todo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { content, status } = value as Record<string, unknown>
  if (typeof content !== 'string') return undefined
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return undefined
  return { content, status }
}

function createdTaskId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const task = (result as { task?: unknown }).task
  if (typeof task !== 'object' || task === null) return undefined
  const id = (task as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Rebuilds the checklist a session that predates the mod would have had:
 * the last TodoWrite on the main loop, every TaskCreate and TaskUpdate in
 * order, and every MANUAL: line Claude wrote. Subagents' calls are ignored.
 */
export function seedFromTranscript(messages: readonly TranscriptMessage[]): Checklist {
  let list = EMPTY_CHECKLIST
  const manualLines: string[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const use of message.toolUses) {
      if (use.agentId !== undefined) continue
      if (use.tool === 'TodoWrite') {
        const raw = use.input.todos
        if (Array.isArray(raw)) list = mergeTodos(list, raw.map(parseTodo).filter((todo): todo is Todo => todo !== undefined)).list
      } else if (use.tool === 'TaskCreate') {
        const taskId = createdTaskId(use.result)
        const subject = use.input.subject
        if (taskId !== undefined && typeof subject === 'string') list = applyTaskEvent(list, { kind: 'created', taskId, subject }).list
      } else if (use.tool === 'TaskUpdate') {
        const { taskId, status, subject } = use.input
        if (typeof taskId !== 'string') continue
        const event: TaskEvent = { kind: 'updated', taskId }
        if (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'deleted') event.status = status
        if (typeof subject === 'string') event.subject = subject
        list = applyTaskEvent(list, event).list
      }
    }
    for (const line of parseManualLines(message.text)) {
      if (!manualLines.includes(line)) manualLines.push(line)
    }
  }

  for (const line of manualLines) list = addManual(list, line).list
  return list
}
