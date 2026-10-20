import { describe, expect, test } from 'claude-code/testing'

import type { BoardSession } from '../types'
import { boardLine, mergeSessions } from '../hooks/board'
import { gistFileName, gistHeaders, gistPatchBody, gistUrl, parseGistFiles } from '../hooks/gist'

const NOW = Date.parse('2026-10-20T12:00:00Z')

const session = (sessionId: string, updatedAt: string, machine?: string): BoardSession => ({
  sessionId,
  project: 'my-app',
  cwd: '/work/my-app',
  summary: 'Fixing login',
  items: [],
  updatedAt,
  ...(machine === undefined ? {} : { machine }),
})

describe('gist requests', () => {
  test('names, url and headers', async () => {
    expect(gistFileName('sess-A')).toBe('sess-A.json')
    expect(gistUrl('abc123')).toBe('https://api.github.com/gists/abc123')
    const headers = gistHeaders('tok', 'W/"etag"')
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['if-none-match']).toBe('W/"etag"')
    expect(gistHeaders('tok')['if-none-match']).toBe(undefined)
  })

  test('a patch body writes some files and deletes others, touching nothing else', async () => {
    const body = JSON.parse(gistPatchBody({ 'sess-A.json': '{"a":1}', 'sess-B.json': null }))
    expect(body).toEqual({ files: { 'sess-A.json': { content: '{"a":1}' }, 'sess-B.json': null } })
  })

  test('parseGistFiles keeps valid sessions and skips the rest', async () => {
    const good = session('sess-B', '2026-10-20T11:55:00Z', 'mac-mini')
    const body = JSON.stringify({
      files: {
        'sess-B.json': { content: JSON.stringify(good), truncated: false },
        'sess-C.json': { content: JSON.stringify(session('sess-C', '2026-10-20T11:00:00Z')), truncated: true },
        'notes.md': { content: 'not a session' },
        'broken.json': { content: '{ nope' },
      },
    })
    expect(parseGistFiles(body)).toEqual([good])
    expect(parseGistFiles('')).toEqual([])
    expect(parseGistFiles('{"files": null}')).toEqual([])
  })
})

describe('merging local files with the gist', () => {
  test('the newer copy of a session wins, and the rest are kept', async () => {
    const local = [session('sess-A', '2026-10-20T11:59:00Z', 'mbp'), session('sess-B', '2026-10-20T11:00:00Z', 'mbp')]
    const remote = [session('sess-A', '2026-10-20T11:30:00Z', 'mbp'), session('sess-B', '2026-10-20T11:50:00Z', 'mbp'), session('sess-C', '2026-10-20T11:40:00Z', 'cloud')]
    const merged = mergeSessions(local, remote)
    expect(merged.map(one => [one.sessionId, one.updatedAt])).toEqual([
      ['sess-A', '2026-10-20T11:59:00Z'],
      ['sess-B', '2026-10-20T11:50:00Z'],
      ['sess-C', '2026-10-20T11:40:00Z'],
    ])
  })

  test('the band tags a session on another machine', async () => {
    const here = session('sess-A', '2026-10-20T11:59:00Z', 'mbp')
    const there = session('sess-C', '2026-10-20T11:40:00Z', 'cloud')
    expect(boardLine(here, true, NOW, 'mbp')).toBe('▶ my-app · Fixing login · 0 open')
    expect(boardLine(there, false, NOW, 'mbp')).toBe('  my-app · Fixing login · 0 open · @cloud')
  })
})
