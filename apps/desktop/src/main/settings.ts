import { appSettingsSchema, type AppSettings } from '@gearmod/contracts'
import type { AppDatabase } from './database'

export const languageFromLocale = (locale: string): AppSettings['idioma'] => (locale.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en')
/**
 * Chromium locale file (`locales/<name>.pak`) of each app language. The package only carries these (`electronLanguages` in
 * package.json, checked by a test): a new app language must add its file there too.
 */
export const chromiumLocales: Record<AppSettings['idioma'], string> = { 'pt-BR': 'pt-BR', en: 'en-US' }
const defaults: AppSettings = { tema: 'green', temasPersonalizados: [], idioma: 'pt-BR', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, chatLateralInicial: true, execucoesSimultaneas: null }
/** A `custom:<id>` theme missing from the list (deleted or corrupted) falls back to the default theme. */
const orphanThemeToDefault = (settings: AppSettings): AppSettings =>
  settings.tema.startsWith('custom:') && !settings.temasPersonalizados.some((t) => `custom:${t.id}` === settings.tema) ? { ...settings, tema: defaults.tema } : settings
const keyOf = (name: keyof AppSettings): string => `app.${name}`

/** App settings in `settings` (key `app.<name>`, JSON value). Invalid values go back to the default. */
export class SettingsRepository {
  /** `systemLocale` (e.g. `() => app.getLocale()`, lazy because Electron only answers correctly after `ready`) decides the language until the user has chosen one. */
  constructor(private readonly database: AppDatabase, private readonly systemLocale: string | (() => string) = 'pt-BR') {}

  get(): AppSettings {
    const rows = this.database.db.prepare(`SELECT key, json_value AS value FROM settings WHERE key LIKE 'app.%'`).all() as Array<{ key: string; value: string }>
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      try { stored[row.key.slice(4)] = JSON.parse(row.value) } catch { /* corrupted value: uses the default */ }
    }
    const base = { ...defaults, idioma: languageFromLocale(typeof this.systemLocale === 'function' ? this.systemLocale() : this.systemLocale) }
    const parsed = appSettingsSchema.safeParse({ ...base, ...stored })
    if (parsed.success) return orphanThemeToDefault(parsed.data)
    return orphanThemeToDefault({ tema: appSettingsSchema.shape.tema.safeParse(stored.tema).data ?? defaults.tema, temasPersonalizados: appSettingsSchema.shape.temasPersonalizados.safeParse(stored.temasPersonalizados).data ?? defaults.temasPersonalizados, idioma: appSettingsSchema.shape.idioma.safeParse(stored.idioma).data ?? base.idioma, voz: appSettingsSchema.shape.voz.safeParse(stored.voz).data ?? defaults.voz, notificacoes: appSettingsSchema.shape.notificacoes.safeParse(stored.notificacoes).data ?? defaults.notificacoes, retomarSozinho: appSettingsSchema.shape.retomarSozinho.safeParse(stored.retomarSozinho).data ?? defaults.retomarSozinho, fotosGravatar: appSettingsSchema.shape.fotosGravatar.safeParse(stored.fotosGravatar).data ?? defaults.fotosGravatar, chatLateralInicial: appSettingsSchema.shape.chatLateralInicial.safeParse(stored.chatLateralInicial).data ?? defaults.chatLateralInicial, execucoesSimultaneas: appSettingsSchema.shape.execucoesSimultaneas.safeParse(stored.execucoesSimultaneas).data ?? defaults.execucoesSimultaneas })
  }

  update(input: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString()
    const upsert = this.database.db.prepare(`INSERT INTO settings(key, json_value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at`)
    this.database.db.transaction(() => {
      for (const name of ['tema', 'temasPersonalizados', 'idioma', 'voz', 'notificacoes', 'retomarSozinho', 'fotosGravatar', 'chatLateralInicial', 'execucoesSimultaneas'] as const) if (input[name] !== undefined) upsert.run(keyOf(name), JSON.stringify(input[name]), now)
    })()
    return this.get()
  }
}
