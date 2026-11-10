import { describe, expect, it } from 'vitest'
import { inlineAvatar, setAvatarFetcher } from './avatar-inline'

const image = (type: string, bytes: number, ok = true): Response => new Response(new Uint8Array(bytes), { status: ok ? 200 : 404, headers: { 'content-type': type } })

describe('inlineAvatar', () => {
  it('turns a host photo into a data URL, asking a small size', async () => {
    const asked: string[] = []
    setAvatarFetcher(async (url) => { asked.push(url); return image('image/png', 4) })
    expect(await inlineAvatar('https://gitlab.example/uploads/-/system/user/avatar/7/avatar.png')).toBe('data:image/png;base64,AAAAAA==')
    expect(asked).toEqual(['https://gitlab.example/uploads/-/system/user/avatar/7/avatar.png?width=64'])
  })

  it('downloads each photo once', async () => {
    let calls = 0
    setAvatarFetcher(async () => { calls++; return image('image/jpeg', 2) })
    await inlineAvatar('https://host/a.jpg'); await inlineAvatar('https://host/a.jpg')
    expect(calls).toBe(1)
  })

  it('drops what is not a usable image', async () => {
    setAvatarFetcher(async () => image('text/html', 10))
    expect(await inlineAvatar('https://host/login')).toBe('')
    setAvatarFetcher(async () => image('image/png', 10, false))
    expect(await inlineAvatar('https://host/missing.png')).toBe('')
    setAvatarFetcher(async () => image('image/png', 300 * 1024))
    expect(await inlineAvatar('https://host/huge.png')).toBe('')
    expect(await inlineAvatar('file:///etc/passwd')).toBe('')
  })
})
