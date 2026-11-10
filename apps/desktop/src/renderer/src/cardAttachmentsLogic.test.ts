import { describe, expect, it } from 'vitest'
import type { CardAttachment } from '@gearmod/contracts'
import { combineMentions, formatSize, matchAttachments, selectAll, selectionSummary, sortAttachments, toggleSelection } from './cardAttachmentsLogic'

const item = (id: string, fileName: string, sizeBytes = 10, createdAt = '2026-01-01T00:00:00Z', available = true): CardAttachment => ({ id, cardId: 'c', fileName, path: `/p/${fileName}`, mediaType: null, sizeBytes, source: 'manual', createdAt, available })

describe('card attachments logic', () => {
  it('matches by name ignoring case and accents, starting names first', () => {
    const items = [item('1', 'meu-relatório.pdf'), item('2', 'Relatorio-final.docx'), item('3', 'foto.png')]
    expect(matchAttachments('RELATORIO', items).map((i) => i.id)).toEqual(['2', '1'])
    expect(matchAttachments('', items)).toHaveLength(3)
    expect(matchAttachments('zzz', items)).toEqual([])
  })
  it('sorts newest first and formats sizes', () => {
    expect(sortAttachments([item('a', 'a', 1, '2026-01-01'), item('b', 'b', 1, '2026-02-01')]).map((i) => i.id)).toEqual(['b', 'a'])
    expect([formatSize(12), formatSize(3482), formatSize(5.2 * 1024 * 1024), formatSize(1.3 * 1024 ** 3)]).toEqual(['12 B', '3.4 KB', '5.2 MB', '1.3 GB'])
  })
  it('toggles, selects all and clears, and summarizes the selection', () => {
    const items = [item('1', 'a', 100), item('2', 'b', 50), item('3', 'c', 5)]
    expect(toggleSelection(toggleSelection([], '1'), '2')).toEqual(['1', '2'])
    expect(toggleSelection(['1'], '1')).toEqual([])
    expect(selectAll(['1'], items)).toEqual(['1', '2', '3'])
    expect(selectAll(['1', '2', '3'], items)).toEqual([])
    expect(selectionSummary(['1', '3'], items)).toEqual({ count: 2, bytes: 105 })
  })
  it('puts card attachments first in the @ list and respects the maximum', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `/f${i}`, relative: `f${i}`, name: `f${i}`, directory: false }))
    const attachments = [item('1', 'nota.txt'), item('2', 'nota2.txt'), item('3', 'gone.txt', 1, '2026-01-01', false)]
    const list = combineMentions('nota', attachments, files)
    expect(list.map((entry) => entry.kind)).toEqual(['card', 'card', 'file', 'file', 'file', 'file', 'file', 'file'])
    expect(combineMentions('', attachments, files, 3)).toHaveLength(3)
    expect(combineMentions('gone', attachments, [])).toEqual([])
  })
})
