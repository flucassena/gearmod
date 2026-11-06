import { useSyncExternalStore } from 'react'
import type { AppLanguage } from '@gearmod/contracts'
import { ptBR } from './pt-BR'
import { en } from './en'

/** Textos da interface. O português é a fonte: cada idioma tem o mesmo formato (chave faltando = erro de tipo). */
export type Messages = typeof ptBR

const dictionaries: Record<AppLanguage, Messages> = { 'pt-BR': ptBR, en }
// Antes das configurações carregarem, usa o idioma do sistema (evita piscar em português para quem usa inglês).
let locale: AppLanguage = typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('pt') ? 'en' : 'pt-BR'
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function setLocale(next: AppLanguage): void {
  if (next === locale) return
  locale = next
  document.documentElement.lang = next
  for (const listener of listeners) listener()
}

export const getLocale = (): AppLanguage => locale

/** Para código fora de componentes (stores, toasts, helpers). Chame na hora de usar, nunca no topo do módulo. */
export const tr = (): Messages => dictionaries[locale]

/** Para componentes: re-renderiza quando o idioma muda. */
export function useT(): Messages {
  useSyncExternalStore(subscribe, getLocale, getLocale)  // o terceiro serve ao renderToString dos testes
  return dictionaries[locale]
}

/** Idioma para `toLocaleString`, `toLocaleDateString` e `Intl.*`. */
export const dateLocale = (): string => locale
