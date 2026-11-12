import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { ProfileRepository } from './projects'
import { SettingsRepository } from './settings'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function open(): Promise<{ root: string; database: AppDatabase }> {
  const root = await mkdtemp(join(tmpdir(), 'gearmod-settings-')); roots.push(root)
  const database = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await database.open()
  return { root, database }
}

describe('SettingsRepository', () => {
  it('defaults to green theme and pt-BR language', async () => {
    const { database } = await open()
    expect(new SettingsRepository(database).get()).toEqual({ tema: 'green', temasPersonalizados: [], idioma: 'pt-BR', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, chatLateralInicial: true, execucoesSimultaneas: null })
    database.close()
  })

  it('with no user choice, the language follows the system one; the saved choice overrides it (I3)', async () => {
    const { database } = await open()
    expect(new SettingsRepository(database, 'en-US').get().idioma).toBe('en')
    expect(new SettingsRepository(database, 'pt-BR').get().idioma).toBe('pt-BR')
    expect(new SettingsRepository(database, 'de').get().idioma).toBe('en')
    new SettingsRepository(database, 'en-US').update({ idioma: 'pt-BR' })
    expect(new SettingsRepository(database, 'en-US').get().idioma).toBe('pt-BR')
    database.close()
  })

  it('Gravatar photos start off and can be turned on (S8)', async () => {
    const { database } = await open()
    const settings = new SettingsRepository(database)
    expect(settings.get().fotosGravatar).toBe(false)
    expect(settings.update({ fotosGravatar: true }).fotosGravatar).toBe(true)
    database.close()
  })

  it('initial side chat starts on and persists updates across restarts', async () => {
    const { root, database } = await open()
    const settings = new SettingsRepository(database)
    expect(settings.get().chatLateralInicial).toBe(true)
    expect(settings.update({ chatLateralInicial: false }).chatLateralInicial).toBe(false)
    expect(database.db.prepare(`SELECT key, json_value FROM settings WHERE key = 'app.chatLateralInicial'`).get()).toEqual({ key: 'app.chatLateralInicial', json_value: 'false' })
    database.close()
    const reopened = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await reopened.open()
    expect(new SettingsRepository(reopened).get().chatLateralInicial).toBe(false)
    reopened.close()
  })

  it('persists app.tema and app.idioma in settings across a restart', async () => {
    const { root, database } = await open()
    const settings = new SettingsRepository(database)
    expect(settings.update({ tema: 'light-sky' })).toEqual({ tema: 'light-sky', temasPersonalizados: [], idioma: 'pt-BR', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, chatLateralInicial: true, execucoesSimultaneas: null })
    expect(settings.update({ idioma: 'en' })).toEqual({ tema: 'light-sky', temasPersonalizados: [], idioma: 'en', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, chatLateralInicial: true, execucoesSimultaneas: null })
    expect(database.db.prepare(`SELECT key, json_value FROM settings ORDER BY key`).all()).toMatchObject([{ key: 'app.idioma', json_value: '"en"' }, { key: 'app.tema', json_value: '"light-sky"' }])
    database.close()
    const reopened = new AppDatabase(join(root, 'db.sqlite'), '0.1.0'); await reopened.open()
    expect(new SettingsRepository(reopened).get()).toEqual({ tema: 'light-sky', temasPersonalizados: [], idioma: 'en', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, chatLateralInicial: true, execucoesSimultaneas: null })
    reopened.close()
  })

  it('falls back to defaults when a stored value is invalid', async () => {
    const { database } = await open()
    database.db.prepare(`INSERT INTO settings(key, json_value, updated_at) VALUES ('app.tema', '"rosa"', 'x'), ('app.idioma', '{oops', 'x'), ('app.chatLateralInicial', '"nope"', 'x')`).run()
    expect(new SettingsRepository(database).get()).toEqual({ tema: 'green', temasPersonalizados: [], idioma: 'pt-BR', voz: 'small', notificacoes: true, retomarSozinho: true, fotosGravatar: false, chatLateralInicial: true, execucoesSimultaneas: null })
    database.close()
  })
})

describe('custom themes', () => {
  const theme = { id: 'abc', nome: 'Meu', cor: '#12ab34', modo: 'dark' as const }
  it('writes and reads temasPersonalizados', async () => {
    const { database } = await open()
    const settings = new SettingsRepository(database)
    expect(settings.update({ tema: 'custom:abc', temasPersonalizados: [theme] })).toMatchObject({ tema: 'custom:abc', temasPersonalizados: [theme] })
    database.close()
  })
  it('falls back to green when the custom theme is not in the list', async () => {
    const { database } = await open()
    const settings = new SettingsRepository(database)
    expect(settings.update({ tema: 'custom:x' }).tema).toBe('green')
    database.close()
  })
  it('turns an invalid list into [] without losing other fields', async () => {
    const { database } = await open()
    database.db.prepare(`INSERT INTO settings(key, json_value, updated_at) VALUES ('app.temasPersonalizados', '[{"id":1}]', 'x'), ('app.idioma', '"en"', 'x')`).run()
    expect(new SettingsRepository(database).get()).toMatchObject({ temasPersonalizados: [], idioma: 'en' })
    database.close()
  })
})

describe('agent color', () => {
  it('uses a provider default, accepts a custom color and keeps it on update', async () => {
    const { root, database } = await open()
    const profiles = new ProfileRepository(database, root)
    const claude = profiles.create({ provider: 'claude', label: 'Claude', scope: 'Pessoal' })
    const codex = profiles.create({ provider: 'codex', label: 'Codex', scope: 'Pessoal', color: '#9ccf6f' })
    expect(claude.color).toBe('#D97757'); expect(codex.color).toBe('#9ccf6f')
    expect(profiles.update({ profileId: codex.id, label: 'Codex 2', scope: 'Pessoal' }).color).toBe('#9ccf6f')
    expect(profiles.update({ profileId: codex.id, label: 'Codex 2', scope: 'Pessoal', color: '#e07a9a' }).color).toBe('#e07a9a')
    database.close()
  })

  it('migrates existing agents to their provider color', async () => {
    const { root, database } = await open()
    database.db.prepare(`INSERT INTO agent_profiles(id, provider, label, scope, config_dir, executable_path, enabled, created_at, updated_at)
      VALUES ('30000000-0000-4000-8000-000000000001', 'claude', 'Antigo', 'Pessoal', ?, NULL, 1, 'x', 'x')`).run(root)
    expect(new ProfileRepository(database, root).list()[0]?.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    database.close()
  })
})
