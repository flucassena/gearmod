import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ignoreBrokenPipe, isBrokenPipe, type WritableLike } from './broken-pipe'

const fakeStream = (write: () => boolean): WritableLike & EventEmitter => Object.assign(new EventEmitter(), { write }) as unknown as WritableLike & EventEmitter
const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('ignoreBrokenPipe', () => {
  it('recognizes EPIPE only', () => {
    expect(isBrokenPipe(failure('EPIPE'))).toBe(true)
    expect(isBrokenPipe(failure('EACCES'))).toBe(false)
    expect(isBrokenPipe(null)).toBe(false)
  })
  it('drops a write that fails with EPIPE instead of throwing', () => {
    const stream = fakeStream(() => { throw failure('EPIPE') })
    ignoreBrokenPipe(stream)
    expect((stream.write as () => boolean)()).toBe(true)
  })
  it('still throws any other write error', () => {
    const stream = fakeStream(() => { throw failure('EIO') })
    ignoreBrokenPipe(stream)
    expect(() => (stream.write as () => boolean)()).toThrow('EIO')
  })
  it('keeps writing normally and ignores an EPIPE error event', () => {
    const written: unknown[] = []
    const record = (...args: unknown[]): boolean => { written.push(args); return true }
    const stream = fakeStream(record as () => boolean)
    ignoreBrokenPipe(stream, undefined)
    ;(stream.write as (text: string) => boolean)('hello')
    expect(written).toEqual([['hello']])
    expect(() => stream.emit('error', failure('EPIPE'))).not.toThrow()
    expect(() => stream.emit('error', failure('EIO'))).toThrow('EIO')
  })
})
