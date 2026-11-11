import React, { useRef, useState } from 'react'
import { tr, useT } from './i18n'
import { PencilIcon } from './icons'

const size = 96

/** Shrinks the chosen image to a 96px square (center crop) and returns a PNG as a data URL: light to store in the database. */
async function shrink(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(tr().settings.icon.notImage)
  // Reads as a data URL: the page's security policy only accepts `data:` images (a `blob:` URL was blocked).
  const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(tr().settings.icon.cannotRead)); reader.readAsDataURL(file) })
  const image = await new Promise<HTMLImageElement>((resolve, reject) => { const item = new Image(); item.onload = () => resolve(item); item.onerror = () => reject(new Error(tr().settings.icon.cannotOpen)); item.src = url })
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size
  const context = canvas.getContext('2d')
  if (!context || !side) throw new Error(tr().settings.icon.cannotOpen)
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size)
  return canvas.toDataURL('image/png')
}

/** Project icon in the sidebar: the chosen image or, without one, the name's initial. */
export function ProjectAvatar({ name, icon }: { name: string; icon: string | null | undefined }): React.JSX.Element {
  return <i className={icon ? 'img' : undefined}>{icon ? <img src={icon} alt="" draggable={false} /> : name.trim()[0]?.toUpperCase() ?? '·'}</i>
}

/** Choose, change or remove the project icon (create project and settings). */
export function ProjectIconPicker({ name, icon, onChange, compact = false }: { name: string; icon: string | null; onChange(icon: string | null): void; compact?: boolean }): React.JSX.Element {
  const t = useT(), ti = t.settings.icon
  const input = useRef<HTMLInputElement>(null), [error, setError] = useState('')
  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try { setError(''); onChange(await shrink(file)) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const choose = <button type="button" className="iconprev editable" aria-label={icon ? ti.changeAria : ti.chooseAria} data-tip={error || (icon ? ti.changeTip : ti.chooseTip)} onClick={() => input.current?.click()}><ProjectAvatar name={name || 'P'} icon={icon} /><span className="iconedit" aria-hidden="true"><PencilIcon /></span></button>
  const file = <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
  if (compact) return <span className="iconpick compact">{choose}{icon && <button type="button" className="iconremove" aria-label={ti.removeAria} data-tip={ti.removeTip} onClick={() => onChange(null)}>×</button>}{file}{error && <span className="iconpick-error" role="status">{error}</span>}</span>
  return <div className="f"><span>{ti.label}</span>
    <div className="iconpick">
      {choose}
      {icon && <button type="button" className="mini secondary" onClick={() => onChange(null)}>{t.common.remove}</button>}
      <small className="hint">{error || ti.formats}</small>
      {file}
    </div>
  </div>
}
