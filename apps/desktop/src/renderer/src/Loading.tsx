import React, { useEffect, useState } from 'react'
import { ThinkingMascot } from './Thinking'
import { useT } from './i18n'

/**
 * The app's standard loading state for a panel, page or dialog body: the thinking mascot with a text below whose dots grow
 * from one to three and start over ("Carregando.", "Carregando..", "Carregando..."). `label` is the text without dots;
 * by default it is "Carregando". For a button or a short inline text, keep the plain text instead.
 */
export function Loading({ label, size = 44, className = '' }: { label?: string; size?: number; className?: string }): React.JSX.Element {
  const t = useT(), text = label ?? t.common.loadingLabel
  const [dots, setDots] = useState(1)
  useEffect(() => { const id = window.setInterval(() => setDots((count) => count % 3 + 1), 450); return () => window.clearInterval(id) }, [])
  // The missing dots stay in the layout (hidden) so the text does not move while they grow.
  return <div className={`loading-state ${className}`} role="status" aria-live="polite" aria-label={text}>
    <ThinkingMascot size={size} />
    <span className="loading-text" aria-hidden="true">{text}<span>{'.'.repeat(dots)}</span><span className="loading-rest">{'.'.repeat(3 - dots)}</span></span>
  </div>
}
