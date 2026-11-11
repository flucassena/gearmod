import React from 'react'
import { useT } from './i18n'
import { AlertIcon, BellIcon, CheckIcon, CloseIcon, InfoIcon } from './icons'

/** The five toast types in the app. Every toast goes through `toast.<type>(...)` and is drawn by this component. */
export type ToastKind = 'success' | 'error' | 'info' | 'warning' | 'notify'

const icons: Record<ToastKind, React.JSX.Element> = {
  success: <CheckIcon />,
  error: <CloseIcon />,
  info: <InfoIcon />,
  warning: <AlertIcon />,
  notify: <BellIcon />
}

export interface ToastCardProps {
  kind: ToastKind; title: string; message?: string
  /** Where it came from (e.g. repository · branch), in small text below. */
  meta?: string
  /** Time in ms until it disappears on its own: shows the timer bar. 0 or empty: stays until closed. */
  duration?: number
  /** Pauses the timer bar (mouse over). */
  paused?: boolean
  onClose?(): void
  onHover?(inside: boolean): void
}

/** Standard toast card (success, error, info, warning or notification). It is the only toast visual in the app. */
export function ToastCard({ kind, title, message, meta, duration = 0, paused = false, onClose, onHover }: ToastCardProps): React.JSX.Element {
  const t = useT()
  return <div className={`ntoast ${kind} ${paused ? 'paused' : ''}`} role={kind === 'error' || kind === 'warning' ? 'alert' : 'status'} aria-label={`${t.shell.toast.kinds[kind]}: ${title}`} onMouseEnter={onHover ? () => onHover(true) : undefined} onMouseLeave={onHover ? () => onHover(false) : undefined}>
    <span className="ntoast-ico" aria-hidden="true">{icons[kind]}</span>
    <div className="ntoast-body">
      <b>{title}</b>
      {message && <p>{message}</p>}
      {meta && <small>{meta}</small>}
    </div>
    {onClose && <button type="button" className="ntoast-x" aria-label={t.shell.toast.closeToast} onClick={onClose}><CloseIcon /></button>}
    {duration > 0 && <i className="ntoast-time" style={{ animationDuration: `${duration}ms` }} aria-hidden="true" />}
  </div>
}
