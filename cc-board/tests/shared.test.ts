import { describe, expect, test } from 'claude-code/testing'

import type { BoardSession } from '../types'
import { deleteUrl, parseRows, readUrl, sharedHeaders, tableUrl, upsertBody, upsertHeaders } from '../hooks/shared'

const session: BoardSession = {
  sessionId: 'sess-B',
  project: 'my-app',
  cwd: '/work/my-app',
  summary: 'Fixing login',
  items: [],
  updatedAt: '2026-10-20T11:55:00Z',
  machine: 'mac-mini',
}

describe('shared board requests', () => {
  test('urls and headers', async () => {
    expect(tableUrl('https://proj.supabase.co/')).toBe('https://proj.supabase.co/rest/v1/cc_board')
    expect(readUrl('https://proj.supabase.co')).toBe('https://proj.supabase.co/rest/v1/cc_board?select=payload')
    expect(decodeURIComponent(deleteUrl('https://proj.supabase.co', ['a', 'b"c']))).toBe('https://proj.supabase.co/rest/v1/cc_board?session_id=in.("a","bc")')
    expect(sharedHeaders('k').authorization).toBe('Bearer k')
    expect(sharedHeaders('k').apikey).toBe('k')
    expect(upsertHeaders('k').prefer).toBe('resolution=merge-duplicates,return=minimal')
  })

  test('an upsert body is one row keyed by session id', async () => {
    expect(JSON.parse(upsertBody(session))).toEqual([{ session_id: 'sess-B', payload: session, updated_at: '2026-10-20T11:55:00Z' }])
  })

  test('parseRows keeps valid sessions and skips the rest', async () => {
    const text = JSON.stringify([{ payload: session }, { payload: { nope: true } }, null, 'x'])
    expect(parseRows(text)).toEqual([session])
    expect(parseRows('')).toEqual([])
    expect(parseRows('{"payload": {}}')).toEqual([])
  })
})
