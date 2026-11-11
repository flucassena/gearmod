// Builds the icon catalog of the design system gallery (docs/design-system.html) from the renderer code.
// It lists the shared icons (icons.tsx, DbIcons.tsx) and every <svg> drawn inline in a component, groups equal drawings
// and shows where each one is used and for what, so a repeated or conflicting icon is easy to spot.
// Usage: node scripts/design-system-icons.mjs   (rewrites the part between <!-- icons:start --> and <!-- icons:end -->)
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const src = join(root, 'apps', 'desktop', 'src', 'renderer', 'src')
const gallery = join(root, 'docs', 'design-system.html')

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : []
})
const files = walk(src).map((path) => ({ path, name: relative(src, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }))

// pt-BR text of an i18n key, by its last name. When the same name has different texts, the text gets a "(?)"
// and stays out of the comparisons.
const dict = readdirSync(join(src, 'i18n', 'pt-BR')).filter((n) => n.endsWith('.ts')).map((n) => readFileSync(join(src, 'i18n', 'pt-BR', n), 'utf8')).join('\n')
const textOf = (key) => {
  const texts = [...new Set([...dict.matchAll(new RegExp(`\\b${key}: (?:'([^']*)'|"([^"]*)"|\\([^)]*\\) => \`([^\`]*)\`)`, 'g'))]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, '…')))]
  return texts.length > 1 ? `${texts[0]} (?)` : texts[0] ?? ''
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length

// What an icon is used for: the label of the element around it (aria-label, data-tip, title or the text next to it).
const leaf = (expr) => (expr.trim().match(/([a-zA-Z_]+)(?:\([^)]*\))?\s*$/) ?? [])[1] ?? ''
const resolve = (expr) => {
  expr = expr.trim()
  const ternary = expr.match(/^[^?]+\?\s*([^:]+?)\s*:\s*(.+)$/)
  if (ternary) return [ternary[1], ternary[2]].map(resolve).filter(Boolean).join(' / ')
  if (/^['"`]/.test(expr)) return expr.slice(1, -1).replace(/\$\{[^}]*\}/g, '…')
  if (!/^[a-zA-Z_.]+(\([^)]*\))?$/.test(expr)) return ''
  // Dictionary objects are short names (t, tb, m, all…); anything else (entry.name, card.title) is data shown next to the icon.
  const head = expr.split('.')[0]
  if (head.length > 3 && head !== 'all' && !expr.startsWith('tr()')) return `(dado: ${expr})`
  return textOf(leaf(expr)) || expr
}
const purpose = (text, index, end) => {
  const before = text.slice(Math.max(0, index - 700), index), after = text.slice(end, end + 220)
  const open = before.lastIndexOf('<button') > before.lastIndexOf('</button>') ? before.slice(before.lastIndexOf('<button')) : before.slice(-260)
  const lineStart = before.slice(before.lastIndexOf('\n') + 1)
  const found = open.match(/(?:aria-label|data-tip|title)=\{([^}]+)\}(?![\s\S]*(?:aria-label|data-tip|title)=)/)
    ?? lineStart.match(/label: ([^,]+),(?![\s\S]*label: )/) // menu item objects: { label: t.x, icon: <Icon /> }
    ?? after.match(/^\s*(?:<[^>]*>)?\{([a-zA-Z_.]+)\}/)
    ?? open.match(/(?:aria-label|data-tip|title)="([^"]+)"/)
  if (found) {
    const text = resolve(found[1])
    if (text) return { key: found[1].trim(), text }
  }
  const plain = after.match(/^\s*([A-Za-zÀ-ú][^<{\n]{1,40})/)
  if (plain) return { key: '', text: plain[1].trim() }
  const parent = before.match(/className="([^"]+)"[^<]*$/)
  return { key: '', text: parent ? `(dentro de .${parent[1].split(' ')[0]})` : '' }
}

const toSvg = (body) => body
  .replace(/\{dot\(([\d.]+), ([\d.]+), ([\d.]+)\)\}/g, '<circle cx="$1" cy="$2" r="$3" fill="currentColor" stroke="none" />') // icons.tsx dots
  .replace(/<\/?>/g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/([a-z])([A-Z])([a-z]*)=/g, (_, a, b, c) => `${a}-${b.toLowerCase()}${c}=`)
  .replace(/=\{(-?[\d.]+)\}/g, '="$1"')
  .replace(/\s+/g, ' ').trim()
const signature = (viewBox, body) => `${viewBox}|${toSvg(body).replace(/\s*(class(Name)?|aria-hidden|key)="[^"]*"/g, '').replace(/\s*\/>/g, '/>')}`

const icons = new Map() // signature -> { names:Set, viewBox, body, filled, dynamic, uses:[] }
const add = (viewBox, body, filled, use, name) => {
  const sig = signature(viewBox, body)
  const item = icons.get(sig) ?? { names: new Set(), viewBox, body: toSvg(body), filled, dynamic: /\{/.test(toSvg(body)), uses: [] }
  if (name) item.names.add(name)
  if (use) item.uses.push(use)
  icons.set(sig, item)
  return item
}

// Shared icons: icons.tsx (make(...)) and DbIcons.tsx (svg('class', ...)), keyed by module, since both have a DatabaseIcon.
const shared = new Map() // 'icons:Name' | 'DbIcons:Name' -> item
for (const file of files.filter((f) => /(^|\/)(icons|DbIcons)\.tsx$/.test(f.name))) {
  const module = file.name.replace(/^.*\//, '').replace('.tsx', '')
  // The one-line comment above each icon is what it means; the catalog shows it and checks the uses against it.
  for (const m of file.text.matchAll(/(?:\/\*\* (.*?) \*\/\n)?export const (\w+) = make\((<.*?>)(?:, \{([^}]*)\})?\)\n/g)) {
    const box = ((m[4] ?? '').match(/box: (\d+)/) ?? [])[1] ?? '24', view = ((m[4] ?? '').match(/view: '([^']+)'/) ?? [])[1]
    const item = add(view ?? `0 0 ${box} ${box}`, m[3], false, null, module === 'icons' ? m[2] : `${module}.${m[2]}`)
    item.doc = m[1] ?? item.doc
    shared.set(`${module}:${m[2]}`, item)
  }
  for (const m of file.text.matchAll(/(?:\/\*\* (.*?) \*\/\n)?export const (\w+) = [^\n]*?svg\([^,]+, (<>[\s\S]*?<\/>)\)/g)) {
    const item = add('0 0 16 16', m[3], false, null, `${module}.${m[2]}`)
    item.doc = m[1] ?? item.doc
    shared.set(`${module}:${m[2]}`, item)
  }
}

for (const file of files) {
  // Uses of the shared icons, by what the file imports from each module.
  for (const imp of file.text.matchAll(/import \{([^}]+)\} from '(?:\.\.?\/)+(icons|DbIcons)'/g)) {
    for (const name of imp[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      const item = shared.get(`${imp[2]}:${name}`)
      if (item) for (const m of file.text.matchAll(new RegExp(`<${name}\\b(?:[^>]|=>)*/>`, 'g'))) item.uses.push({ file: file.name, line: lineOf(file.text, m.index), ...purpose(file.text, m.index, m.index + m[0].length) })
    }
  }
  if (/DbIcons\.tsx$/.test(file.name)) for (const [key, item] of shared) if (key.startsWith('DbIcons:')) {
    const name = key.slice(8)
    for (const m of file.text.matchAll(new RegExp(`<${name}\\b(?:[^>]|=>)*/>`, 'g'))) item.uses.push({ file: file.name, line: lineOf(file.text, m.index), ...purpose(file.text, m.index, m.index + m[0].length) })
  }
  if (/(^|\/)(icons|DbIcons)\.tsx$/.test(file.name)) continue
  // Inline drawings.
  for (const m of file.text.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)) {
    const viewBox = (m[1].match(/viewBox="([^"]+)"/) ?? [])[1] ?? '0 0 24 24'
    if (!m[2].trim() || /^\{[^}]*\}$/.test(m[2].trim())) continue
    add(viewBox, m[2], /fill="currentColor"/.test(m[1]), { file: file.name, line: lineOf(file.text, m.index), ...purpose(file.text, m.index, m.index + m[0].length) })
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const list = [...icons.values()].filter((item) => item.uses.length || item.names.size)
const meaning = (use) => (use.text || use.key || '—').trim()
for (const item of list) item.meanings = [...new Set(item.uses.map(meaning).filter((m) => m !== '—' && !m.startsWith('(')))]

// Same drawing used for different things, and the same thing drawn in different ways.
// An icon used for more than one thing is fine when icons.tsx says what it means ("Close or hide a panel, chat, file…"):
// only an icon without a written meaning is flagged.
const repeated = list.filter((item) => item.meanings.length > 1 && !item.doc)
// The same thing is matched by the i18n key name (openCard, openCardTip and openCardAria are one thing), or by the text when
// there is no key. Toggle buttons ("Expandir / Recolher") change the icon on purpose and "(dentro de …)" is not a meaning: both stay out.
const thing = (use) => {
  if (use.text.startsWith('(')) return ''
  if (!use.key || /\?/.test(use.key)) return /^\(|\(\?\)| \/ /.test(use.text) || !use.text ? '' : use.text.toLowerCase()
  // A key name with different texts (hide = "Ocultar terminal" and "Ocultar visão rápida") is only the same thing with the same full key.
  if (use.text.includes('(?)')) return use.key.replace(/\s+/g, '').toLowerCase()
  return leaf(use.key).replace(/(Tip|Aria|Label|Title)$/, '').toLowerCase()
}
const byMeaning = new Map()
for (const item of list) for (const use of item.uses) {
  const key = thing(use)
  if (!key) continue
  const group = byMeaning.get(key) ?? { label: '', items: new Set(), lines: new Set() }
  if (!group.label || group.label.includes('(?)')) group.label = meaning(use)
  group.items.add(item)
  group.lines.add(`${use.file}:${use.line}`)
  byMeaning.set(key, group)
}
// Two icons on one line for one thing are a toggle ({open ? <Down /> : <Right />}): on purpose.
const mixed = [...byMeaning.values()].filter((group) => group.items.size > 1 && group.lines.size > 1).map((group) => [group.label.replace(/ \(\?\)$/, ''), [...group.items]])
const duplicated = list.filter((item) => item.names.size > 1)
const unused = list.filter((item) => item.names.size && !item.uses.length)

const draw = (item, size = 22) => item.dynamic
  ? `<span class="g-ico-dyn" title="desenho montado em tempo de execução">dinâmico</span>`
  : `<svg viewBox="${esc(item.viewBox)}" width="${size}" height="${size}" class="ico" aria-hidden="true">${item.body}</svg>` // the app's own icon CSS
const title = (item) => item.names.size ? [...item.names].join(' = ') : item.uses.length === 1 ? 'inline' : `inline ×${item.uses.length}`
const card = (item) => `<div class="g-ico${item.meanings.length > 1 && !item.doc ? ' warn' : ''}"><div class="g-ico-draw">${draw(item, 26)}</div><div class="g-ico-body"><b>${esc(title(item))}</b>${item.doc ? `<em>${esc(item.doc)}</em>` : ''}${
  item.uses.length ? `<ul>${item.uses.map((u) => `<li><span>${esc(meaning(u))}</span><code>${esc(u.file)}:${u.line}</code></li>`).join('')}</ul>` : '<small>não usado</small>'}</div></div>`
const sorted = [...list].sort((a, b) => (b.names.size ? 1 : 0) - (a.names.size ? 1 : 0) || b.meanings.length - a.meanings.length || title(a).localeCompare(title(b)))

if (process.argv.includes('--json')) { console.log(JSON.stringify(sorted.map((i) => ({ name: title(i), viewBox: i.viewBox, filled: i.filled, body: i.body, uses: i.uses.map((u) => `${u.file}:${u.line} ${meaning(u)}`) })), null, 1)); process.exit(0) }
const html = `<!-- icons:start (gerado por scripts/design-system-icons.mjs; não edite à mão) -->
  <section id="icones">
    <h2>Ícones · <span class="g-code">${list.length} desenhos · ${list.reduce((n, i) => n + i.uses.length, 0)} usos</span></h2>
    <h3 class="g-h3">Todos os ícones compartilhados, no mesmo tamanho (${shared.size})</h3>
    <p class="g-sub" style="margin:0 0 10px">Padrão: traço de <code>--icon-stroke</code> (1.5px) igual em qualquer tamanho, pontas e cantos arredondados, sem preenchimento (só pontinhos são cheios). Formas ocupam 75% da caixa (18 de 24, como o Lucide); setas de navegação 58%; X, +, ✓, setinhas e pontinhos mantêm o tamanho do Lucide. Abaixo, cada um em 16px e em 24px.</p>
    <div class="g-all">${[...shared].sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `<div class="g-all-i" title="${esc(item.doc ?? key)}"><span>${draw(item, 16)}${draw(item, 24)}</span><small>${esc(key.replace(/^icons:/, '').replace(':', '.'))}</small></div>`).join('')}</div>
    <h3 class="g-h3">Onde cada um é usado</h3>
    <p class="g-sub" style="margin:0 0 12px">Gerado do código: <code>icons.tsx</code>, <code>DbIcons.tsx</code> e cada <code>&lt;svg&gt;</code> escrito dentro de um componente. "Para quê" vem do rótulo do botão (aria-label, data-tip, title ou texto ao lado); "(?)" marca um texto incerto (a mesma chave tem textos diferentes no pt-BR).</p>
    ${repeated.length ? `<div class="ds-note tone-warning" style="margin:0 0 10px"><span class="ds-note-i">!</span><span><b>Usado para mais de uma coisa, sem significado escrito em icons.tsx (${repeated.length}).</b> Escreva o que o ícone significa na linha acima dele; se os usos não cabem num significado só, cada um precisa do próprio ícone.</span></div><div class="g-icos">${repeated.map(card).join('')}</div>`
      : '<div class="ds-note tone-success" style="margin:0 0 8px"><span class="ds-note-i">✓</span><span><b>Todo ícone tem o significado escrito em icons.tsx</b>, e os usos abaixo seguem esse significado.</span></div>'}
    ${mixed.length ? `<div class="ds-note tone-warning" style="margin:16px 0 10px"><span class="ds-note-i">!</span><span><b>Mesma coisa, desenhos diferentes (${mixed.length}).</b> Deveria ser um ícone só.</span></div>`
      : '<div class="ds-note tone-success" style="margin:0 0 8px"><span class="ds-note-i">✓</span><span><b>Nenhuma coisa desenhada de dois jeitos.</b></span></div>'}
    <div class="g-mixed">${mixed.map(([m, items]) => `<div><span>${esc(m)}</span><span class="g-mixed-icos">${items.map((i) => `<span data-tip="${esc(title(i))}">${draw(i)}</span>`).join('')}</span></div>`).join('')}</div>
    ${duplicated.length ? `<div class="ds-note tone-info" style="margin:16px 0 10px"><span class="ds-note-i">i</span><span><b>Ícones compartilhados com o mesmo desenho (${duplicated.length}).</b></span></div><div class="g-icos">${duplicated.map(card).join('')}</div>` : ''}
    ${unused.length ? `<div class="ds-note" style="margin:16px 0 10px"><span><b>Compartilhados sem uso (${unused.length}).</b></span></div><div class="g-icos">${unused.map(card).join('')}</div>` : ''}
    <h2 style="margin-top:20px">Catálogo completo</h2>
    <div class="g-icos">${sorted.map(card).join('')}</div>
  </section>
  <!-- icons:end -->`

const page = readFileSync(gallery, 'utf8')
const next = page.replace(/<!-- icons:start[\s\S]*?<!-- icons:end -->/, html)
if (next === page && !page.includes('<!-- icons:start')) throw new Error('docs/design-system.html has no <!-- icons:start --> / <!-- icons:end --> markers')
writeFileSync(gallery, next)
console.log(`${list.length} drawings, ${repeated.length} used for more than one thing, ${mixed.length} meanings drawn in more than one way.`)
