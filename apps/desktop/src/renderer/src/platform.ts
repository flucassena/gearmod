/** The system the app runs on, seen from the window. The Mac changes the title bar (window buttons on the left) and the shortcut labels. */
export function isMac(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return /Mac/i.test(platform)
}

/** Marks the page with the system (`data-platform="mac"`), so the CSS can leave room for the Mac window buttons. */
export function markPlatform(root: HTMLElement, platform?: string): void {
  if (isMac(platform)) root.dataset.platform = 'mac'
}
