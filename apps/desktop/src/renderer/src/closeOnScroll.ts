/**
 * App-wide rule: scrolling outside an open menu or select closes it (like clicking outside).
 * Every popup already closes on a press outside, so a synthetic press on <body> does it without each one needing its own listener.
 * It listens to the wheel and touch (the user scrolling), not to `scroll` events, so a chat that scrolls by itself while streaming leaves the menu alone.
 * Scrolling inside the popup itself (a long list) is ignored.
 */
const POPUP = '[role="menu"],[role="listbox"],.sel-list,.floating-select-list'

export function installCloseOnScroll(): void {
  const outside = (event: Event): void => {
    if (!document.querySelector(POPUP)) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(POPUP)) return
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  }
  window.addEventListener('wheel', outside, { capture: true, passive: true })
  window.addEventListener('touchmove', outside, { capture: true, passive: true })
}
