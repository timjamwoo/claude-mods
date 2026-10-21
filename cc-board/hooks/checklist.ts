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
  | { kind: 'followup-added'; item: ChecklistItem }
  | { kind: 'kept-done'; item: ChecklistItem }
  | { kind: 'auto-done'; item: ChecklistItem }

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
    // A task Claude takes on that reads like an open manual step or loose end adopts that item: when
    // the task completes, the item does too.
    const adopted = sameText ?? list.items.find(item => item.source !== 'todo' && item.taskId === undefined && item.status !== 'completed' && isSimilar(item.text, subject))
    if (adopted !== undefined) {
      const item = { ...adopted, taskId: event.taskId }
      return { list: { ...list, items: list.items.map(one => (one === adopted ? item : one)) }, item }
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
  const manual = list.items.filter(item => item.source !== 'todo')
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
export function addManual(list: Checklist, text: string): { list: Checklist; item: ChecklistItem; added: boolean } {
  return addItem(list, text, 'manual')
}

/** Adds a loose end surfaced from the conversation, unless an item already says the same thing. */
export function addFollowUp(list: Checklist, text: string): { list: Checklist; item: ChecklistItem; added: boolean } {
  return addItem(list, text, 'followup')
}

/** Lower case, no punctuation, one space between words: how two items are judged the same. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function addItem(list: Checklist, text: string, source: 'manual' | 'followup'): { list: Checklist; item: ChecklistItem; added: boolean } {
  const trimmed = text.trim()
  const key = normalizeText(trimmed)
  const existing = list.items.find(item => normalizeText(item.text) === key)
  if (existing !== undefined) return { list, item: existing, added: false }

  const item: ChecklistItem = { id: list.nextId, text: trimmed, source, status: 'pending', ticked: false }
  return { list: { items: [...list.items, item], nextId: list.nextId + 1 }, item, added: true }
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'then', 'than', 'into', 'onto', 'your', 'their', 'once', 'when',
  'after', 'before', 'later', 'also', 'make', 'sure', 'need', 'needs', 'have', 'will', 'should', 'still', 'done', 'again',
])

/** The words of `text` worth matching on: four letters or more, lower case, no stop words, no repeats. */
export function keywords(text: string): string[] {
  const found = new Set<string>()
  for (const word of normalizeText(text).split(' ')) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) found.add(word)
  }
  return [...found]
}

/** True when two texts share at least two keywords and most of the shorter text's keywords. */
export function isSimilar(a: string, b: string): boolean {
  const left = keywords(a)
  const right = new Set(keywords(b))
  const shared = left.filter(word => right.has(word)).length
  const shorter = Math.min(left.length, right.size)
  return shared >= 2 && shared * 10 >= shorter * 6
}

/**
 * The open manual steps and loose ends that `text` might have handled: those
 * sharing at least two keywords with it. The cheap gate before asking Haiku.
 */
export function candidatesHandled(items: readonly ChecklistItem[], text: string): ChecklistItem[] {
  const words = new Set(keywords(text))
  return items.filter(item => {
    if (item.source === 'todo' || item.status === 'completed') return false
    return keywords(item.text).filter(word => words.has(word)).length >= 2
  })
}

/** The ids a "which items were handled" reply names, limited to the candidates it was asked about. */
export function parseHandledIds(reply: string, candidates: readonly ChecklistItem[]): number[] {
  const allowed = new Set(candidates.map(item => item.id))
  const ids: number[] = []
  for (const line of reply.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?#?(\d+)\b/.exec(line)
    if (match === null) continue
    const id = Number(match[1])
    if (allowed.has(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Marks the named items completed because the work was seen done, leaving the person's own ticks alone. */
export function markHandled(list: Checklist, ids: readonly number[]): { list: Checklist; items: ChecklistItem[] } {
  const done: ChecklistItem[] = []
  const items = list.items.map(item => {
    if (!ids.includes(item.id) || item.status === 'completed') return item
    const handled: ChecklistItem = { ...item, status: 'completed' }
    done.push(handled)
    return handled
  })
  return { list: { ...list, items }, items: done }
}

const LOOSE_END_CUE =
  /\b(later|remember|remind|don'?t forget|manual(?:ly)?|by hand|follow[ -]?ups?|out of scope|for now|not yet|still (?:need|have|to)|(?:you|we)(?:'ll| will| would| should| need| have)? (?:need|have|want) to|todo|to-do|make sure|before (?:you |we )?(?:ship|release|merge|deploy)|eventually|at some point|next steps?|after (?:this|that)|once (?:you|we)|when you get a chance|left (?:out|as is)|skipp?ed|deferred|temporar(?:y|ily)|workaround|not (?:yet )?(?:done|handled|covered|implemented))\b/i

/** Whether an exchange is worth reading for loose ends. Cheap, so it runs on every turn. */
export function hasLooseEndCue(text: string): boolean {
  return LOOSE_END_CUE.test(text)
}

/**
 * What a scan reads of a long exchange: the whole text when it fits, else
 * the passages around every cue, with `radius` characters of context each
 * side, merged where they overlap. Past `max`, the latest passages are kept.
 */
export function cueExcerpts(text: string, max = 6000, radius = 600): string {
  if (text.length <= max) return text
  const windows: [number, number][] = []
  for (const match of text.matchAll(new RegExp(LOOSE_END_CUE.source, 'gi'))) {
    const start = Math.max(0, match.index - radius)
    const end = Math.min(text.length, match.index + match[0].length + radius)
    const last = windows[windows.length - 1]
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else windows.push([start, end])
  }
  const joined = windows.map(([start, end]) => text.slice(start, end)).join('\n…\n')
  return joined.length <= max ? joined : joined.slice(joined.length - max)
}

/**
 * The loose ends a model listed, one per line: bullets and numbering
 * stripped, NONE and empty lines dropped, repeats and over-long lines removed.
 */
export function parseFollowUpLines(reply: string, max = 3): string[] {
  const lines: string[] = []
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
    if (line === '' || /^none\.?$/i.test(line) || line.length > 120) continue
    if (lines.some(one => normalizeText(one) === normalizeText(line))) continue
    lines.push(line)
    if (lines.length === max) break
  }
  return lines
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
  const followUps = of('followup-added')
  const kept = of('kept-done')
  const auto = of('auto-done')

  const parts: string[] = []
  if (ticked.length > 0) parts.push(`The user ticked these done: ${quote(ticked)}.`)
  if (auto.length > 0) parts.push(`Marked done because this exchange handled them: ${quote(auto)}.`)
  if (kept.length > 0) {
    parts.push(`These stay done because the user ticked them, although your TodoWrite reopened them: ${quote(kept)}.`)
  }
  if (unticked.length > 0) parts.push(`The user reopened: ${quote(unticked)}.`)
  if (manual.length > 0) parts.push(`New manual steps the user will do by hand (not you): ${quote(manual)}.`)
  if (followUps.length > 0) {
    parts.push(`Loose ends noted on the user's checklist so they are not forgotten (no action from you unless asked): ${quote(followUps)}.`)
  }
  if (ticked.length > 0 || kept.length > 0 || auto.length > 0) {
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

function updateFailed(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { success?: unknown }).success === false
}

/**
 * Brings a saved checklist up to date with what the transcript says: a task
 * the transcript knows and the saved list lacks is added, a saved task that
 * matches one by id or text keeps its tick and gains the id. Nothing saved is
 * removed, so manual steps and ticks survive.
 */
export function reconcile(saved: Checklist, replayed: Checklist): Checklist {
  let list = saved
  for (const item of replayed.items) {
    if (item.source === 'manual' || item.source === 'followup') {
      list = addItem(list, item.text, item.source).list
      continue
    }
    const known = list.items.find(one => (item.taskId !== undefined && one.taskId === item.taskId) || (one.source === 'todo' && one.text === item.text))
    if (known === undefined) {
      list = { items: [...list.items, { ...item, id: list.nextId }], nextId: list.nextId + 1 }
    } else if (known.taskId === undefined && item.taskId !== undefined) {
      const linked = { ...known, taskId: item.taskId }
      list = { ...list, items: list.items.map(one => (one === known ? linked : one)) }
    }
  }
  return list
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
        if (updateFailed(use.result)) continue
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
