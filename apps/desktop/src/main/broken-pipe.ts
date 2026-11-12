/**
 * A closed console pipe must never take the app down. When GearMod is opened from a terminal or script that has since gone away, stdout/stderr point at a
 * broken pipe, and the next `console.error` (Electron logs every failed IPC call that way, e.g. a worktree that could not be deleted) throws `EPIPE` as an
 * uncaught exception and shows the "A JavaScript error occurred in the main process" dialog. The write is dropped instead; any other error still surfaces.
 */
export interface WritableLike { write: (...args: never[]) => boolean; on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown }

export const isBrokenPipe = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'EPIPE'

export function ignoreBrokenPipe(...streams: Array<WritableLike | undefined>): void {
  for (const stream of streams) {
    if (!stream) continue
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
    // The failure is thrown synchronously from `write` (a SyncWriteStream), so an 'error' listener alone does not catch it.
    stream.write = ((...args: unknown[]): boolean => { try { return write(...args) } catch (error) { if (isBrokenPipe(error)) return true; throw error } }) as WritableLike['write']
    stream.on('error', (error) => { if (!isBrokenPipe(error)) throw error })
  }
}
