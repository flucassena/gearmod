/**
 * Stable codes for errors the screen needs to recognize. The text stays translated; the code goes as a `[[code]] ` prefix,
 * which the screen reads with `errorCodeOf` and strips with `withoutErrorCode`. This way translating the text in main does not break the screen.
 */
export const errorCodes = ['git-push-rejected', 'git-push-stale', 'no-worktree', 'branch-not-merged', 'nothing-to-continue'] as const
export type ErrorCode = (typeof errorCodes)[number]

const marker = /^\[\[([a-z-]+)\]\] ?/

export const withErrorCode = (code: ErrorCode, message: string): string => `[[${code}]] ${message}`
export function errorCodeOf(text: string): ErrorCode | null {
  const code = marker.exec(text)?.[1]
  return (errorCodes as readonly string[]).includes(code ?? '') ? code as ErrorCode : null
}
export const withoutErrorCode = (text: string): string => text.replace(marker, '')
