import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Keeps the menu attached to the button, with a height limit and without clipping by the container. */
export function useFloatingMenu(open: boolean, button: RefObject<HTMLButtonElement | null>, preferUp = false, minWidth = 170): CSSProperties | undefined {
  const [box, setBox] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!open) return
    const position = (): void => {
      const rect = button.current?.getBoundingClientRect(); if (!rect) return
      const below = Math.max(0, window.innerHeight - rect.bottom - 12), above = Math.max(0, rect.top - 12)
      const flip = preferUp ? above > 0 : below < 200 && above > below
      const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - 16)
      setBox({ position: 'fixed', left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, right: 'auto', ...(flip ? { top: 'auto', bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5, bottom: 'auto' }), maxHeight: Math.max(0, Math.min(280, (flip ? above : below) - 5)) })
    }
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, button, preferUp, minWidth])
  return box
}
