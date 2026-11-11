/* Shared by the home page and the download page: language, the release list read from GitHub and the visitor platform. */
(function () {
  var REPO = 'flucassena/gearmod';
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;

  /* ---- language: saved choice, else browser language ---- */
  function setLang(l) {
    root.dataset.lang = l; root.lang = l;
    try { localStorage.setItem('gm-lang', l); } catch (e) {}
    renderReleases();
  }
  var saved = null; try { saved = localStorage.getItem('gm-lang'); } catch (e) {}
  root.dataset.lang = saved || (/^pt/i.test(navigator.language || '') ? 'pt' : 'en');
  document.querySelectorAll('.lang button').forEach(function (b) { b.addEventListener('click', function () { setLang(b.dataset.set); }); });
  if ($('year')) $('year').textContent = new Date().getFullYear();

  /* ---- releases: read live from the GitHub API, so a new tag shows up with no redeploy ---- */
  var releases = null;
  var T = {
    en: { latest: 'Latest', pre: 'Pre-release', dl: 'Download', notes: 'Release notes', sums: 'SHA-256', none: 'No release published yet. Check back soon, or build from source (see the README).', fail: 'Could not load the version list. Open the releases page on GitHub.', all: 'See on GitHub', count: function (n) { return n + (n === 1 ? ' version' : ' versions'); }, kinds: { windows: 'Windows', appimage: 'AppImage', deb: '.deb', mac: 'macOS (Apple Silicon)', macintel: 'macOS (Intel)' } },
    pt: { latest: 'Mais recente', pre: 'Pré-release', dl: 'Baixar', notes: 'Notas da versão', sums: 'SHA-256', none: 'Nenhuma release publicada ainda. Volte em breve, ou compile do código-fonte (veja o README).', fail: 'Não deu para carregar a lista de versões. Abra a página de releases no GitHub.', all: 'Ver no GitHub', count: function (n) { return n + (n === 1 ? ' versão' : ' versões'); }, kinds: { windows: 'Windows', appimage: 'AppImage', deb: '.deb', mac: 'macOS (Apple Silicon)', macintel: 'macOS (Intel)' } }
  };
  function lang() { return root.dataset.lang === 'pt' ? 'pt' : 'en'; }
  function mb(n) { return (n / 1048576).toFixed(0) + ' MB'; }
  function date(s) { return new Date(s).toLocaleDateString(lang() === 'pt' ? 'pt-BR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* macOS (preview). The tab, the hero chip and the list entries show up only once a release has the .dmg files; false hides the Mac everywhere. */
  var MAC_ENABLED = true;
  var KINDS = { windows: /\.exe$/i, appimage: /\.AppImage$/i, deb: /\.deb$/i, mac: /-arm64\.dmg$/i, macintel: /-x64\.dmg$/i };
  /* Main file of each platform (the hero button and the version line use it). */
  var MAIN = { windows: 'windows', linux: 'appimage', mac: 'mac' };
  function enabled(kind) { return !/^mac/.test(kind) || MAC_ENABLED; }
  function assetOf(r, kind) { return enabled(kind) ? (r.assets || []).filter(function (a) { return KINDS[kind].test(a.name); })[0] : undefined; }
  function sumsOf(r) { return (r.assets || []).filter(function (a) { return /SHA256SUMS/i.test(a.name); })[0]; }
  function hasAny(r) { return Object.keys(KINDS).some(function (kind) { return assetOf(r, kind); }); }
  /* Newest release that has the platform's main file. */
  function latestFor(rows, os) { return rows.filter(function (r) { return !r.prerelease && assetOf(r, MAIN[os]); })[0] || rows.filter(function (r) { return assetOf(r, MAIN[os]); })[0]; }

  /* ---- platform: the visitor's system picks the hero button and the first tab (Android counts as "other": it says Linux too) ---- */
  function visitorOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '') + ' ' + navigator.userAgent;
    if (/android|iphone|ipad/i.test(p)) return 'windows';
    if (/mac/i.test(p)) return 'mac';
    if (/linux|x11|cros/i.test(p)) return 'linux';
    return 'windows';
  }
  var NAMES = { windows: 'Windows', linux: 'Linux', mac: 'macOS' };
  var wanted = visitorOS();
  root.dataset.os = 'windows'; root.dataset.dl = 'windows';
  function selectTab(os) {
    root.dataset.dl = os;
    document.querySelectorAll('[data-os-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.osTab === os)); });
    paintVersion();
  }
  document.querySelectorAll('[data-os-tab]').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.osTab); }); });
  /* Copy buttons of the command boxes (Linux install, Mac first launch); fall back to selecting the text when the clipboard is not available. */
  document.querySelectorAll('[data-copy]').forEach(function (b) { b.addEventListener('click', function () {
    var code = $(b.dataset.copy), button = this, label = button.innerHTML;
    var done = function () { button.textContent = lang() === 'pt' ? 'Copiado' : 'Copied'; setTimeout(function () { button.innerHTML = label; }, 1500); };
    var select = function () { var range = document.createRange(); range.selectNodeContents(code); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code.textContent).then(done, select); else select();
  }); });

  /* Platform icons: Windows drawn here, Apple and Linux from Simple Icons (CC0). */
  var ICONS = {
    windows: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.5 10.5 4.4v7.1H3V5.5Zm8.6-1.2L21 3v8.5h-9.4V4.3ZM3 12.5h7.5v7.1L3 18.5v-6Zm8.6 0H21V21l-9.4-1.3v-7.2Z"/></svg>',
    mac: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
    linux: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"/></svg>'
  };
  var ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>';
  var ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>';
  document.querySelectorAll('[data-os-tab]').forEach(function (b) { if (ICONS[b.dataset.osTab]) b.insertAdjacentHTML('afterbegin', ICONS[b.dataset.osTab]); });
  /* One row per platform in each version, with its files. */
  var GROUPS = [
    { os: 'windows', kinds: ['windows'], sub: { en: 'Windows 10/11 · x64', pt: 'Windows 10/11 · x64' } },
    { os: 'linux', kinds: ['appimage', 'deb'], sub: { en: 'x64 · any distro or Debian/Ubuntu', pt: 'x64 · qualquer distro ou Debian/Ubuntu' } },
    { os: 'mac', kinds: ['mac', 'macintel'], sub: { en: 'macOS 12+ · preview', pt: 'macOS 12+ · prévia' } }
  ];
  var FILE = { en: { windows: 'Installer (.exe)', appimage: 'AppImage', deb: '.deb', mac: 'Apple Silicon', macintel: 'Intel' }, pt: { windows: 'Instalador (.exe)', appimage: 'AppImage', deb: '.deb', mac: 'Apple Silicon', macintel: 'Intel' } };
  function versionOf(r) { return String(r.tag_name || r.name || '').replace(/^v/i, ''); }

  function renderReleases() {
    var t = T[lang()], list = $('rel-list');
    if (releases === null) return;
    if (releases === false) { if (!list) return; list.innerHTML = '<div class="rel-empty">' + t.fail + ' <a href="https://github.com/' + REPO + '/releases">' + t.all + '</a></div>'; return; }
    var rows = releases.filter(function (r) { return !r.draft && hasAny(r); });
    if ($('rel-count')) $('rel-count').textContent = rows.length ? t.count(rows.length) : '';
    if (!rows.length) { if (list) list.innerHTML = '<div class="rel-empty">' + t.none + '</div>'; return; }
    var firstStable = rows.filter(function (r) { return !r.prerelease; })[0] || rows[0];
    if (list) list.innerHTML = rows.map(function (r) {
      var sums = sumsOf(r), v = versionOf(r);
      var badge = r.id === firstStable.id ? '<span class="badge">' + t.latest + '</span>' : (r.prerelease ? '<span class="badge pre">' + t.pre + '</span>' : '');
      var platforms = GROUPS.map(function (g) {
        var files = g.kinds.map(function (kind) {
          var a = assetOf(r, kind);
          return a ? '<a class="file" href="' + esc(a.browser_download_url) + '" title="' + esc(a.name) + '">' + ICON_DL + '<span>' + FILE[lang()][kind] + '</span><small>' + mb(a.size) + '</small></a>' : '';
        }).join('');
        if (!files) return '';
        return '<div class="os-row"><span class="os-ic">' + ICONS[g.os] + '</span>' +
          '<span class="os-name">' + NAMES[g.os] + '<small>' + g.sub[lang()] + '</small></span>' +
          '<div class="os-files">' + files + '</div></div>';
      }).join('');
      return '<article class="rel-item' + (r.id === firstStable.id ? ' is-latest' : '') + '">' +
        '<header class="rel-top"><div class="v">GearMod ' + esc(v) + badge + '<span class="d">' + date(r.published_at || r.created_at) + '</span></div>' +
        '<div class="rel-actions"><button type="button" class="btn small" data-notes="' + esc(v) + '">' + ICON_DOC + t.notes + '</button>' +
        (sums ? '<a class="btn small ghost" href="' + esc(sums.browser_download_url) + '" title="SHA256SUMS.txt">' + t.sums + '</a>' : '') + '</div></header>' +
        '<div class="rel-os">' + platforms + '</div></article>';
    }).join('');
    paintPlatforms(rows);
    notes.ready(rows);
  }

  /* ---- release notes: release-notes/<version>.md (English) and <version>.pt-BR.md, copied into the site by the Pages deploy ---- */
  var notes = (function () {
    var dlg = $('notes-dlg'), rows = [], current = null, noteLang = 'en', cache = {}, opened = false;
    var L = {
      en: { title: 'Release notes', github: 'View on GitHub', loading: 'Loading…', missing: 'This version has no notes in English.', close: 'Close', versions: 'Versions' },
      pt: { title: 'Notas da versão', github: 'Ver no GitHub', loading: 'Carregando…', missing: 'Esta versão não tem notas.', fallback: 'Estas notas ainda não têm versão em português. Mostrando a versão em inglês.', close: 'Fechar', versions: 'Versões' }
    };
    function file(v, l) { return v + (l === 'pt' ? '.pt-BR' : '') + '.md'; }
    function text(url) { return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); }); }
    /* The site's copy first; the repository on GitHub when the deploy has no copy (local preview). */
    function get(v, l) {
      var key = v + '|' + l;
      if (!cache[key]) cache[key] = text('release-notes/' + file(v, l)).catch(function () { return text('https://raw.githubusercontent.com/' + REPO + '/main/release-notes/' + file(v, l)); });
      return cache[key];
    }
    function inline(s) {
      var codes = [];
      s = esc(s).replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[+i] + '</code>'; });
    }
    /* Small Markdown subset: headings, lists, paragraphs, code blocks, bold, code and links. */
    function md(src) {
      var out = [], para = [], list = null, code = null, n = 0;
      function flush() {
        if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
        para = [];
        if (list) out.push('<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>');
        list = null;
      }
      src.replace(/\r/g, '').split('\n').forEach(function (line) {
        if (code) { if (/^```/.test(line)) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; } else code.push(line); return; }
        if (/^```/.test(line)) { flush(); code = []; return; }
        var h = /^(#{1,4})\s+(.*)$/.exec(line), li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (h) { flush(); var lvl = Math.max(2, h[1].length); out.push('<h' + lvl + (lvl === 3 ? ' id="sec-' + (n++) + '"' : '') + '>' + inline(h[2]) + '</h' + lvl + '>'); return; }
        if (li) { var tag = /\d/.test(li[1]) ? 'ol' : 'ul'; if (para.length || !list || list.tag !== tag) { flush(); list = { tag: tag, items: [] }; } list.items.push(li[2]); return; }
        if (!line.trim()) { flush(); return; }
        if (list && /^\s{2,}/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); return; }
        if (list) flush();
        para.push(line.trim());
      });
      if (code) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      flush();
      return out.join('');
    }
    function rowOf(v) { return rows.filter(function (r) { return versionOf(r) === v; })[0]; }
    function chrome() {
      var ui = L[lang()];
      $('notes-title').textContent = ui.title;
      $('notes-close').setAttribute('aria-label', ui.close);
      $('notes-nav-label').textContent = ui.versions;
      $('notes-gh').textContent = ui.github;
      dlg.querySelectorAll('[data-note-lang]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.noteLang === noteLang)); });
      $('notes-nav').innerHTML = rows.map(function (r, i) {
        var v = versionOf(r);
        return '<button type="button" data-note-ver="' + esc(v) + '" aria-current="' + (v === current) + '"><b>' + esc(v) + (i === 0 ? '<span class="badge">' + T[lang()].latest + '</span>' : '') + '</b><small>' + date(r.published_at || r.created_at) + '</small></button>';
      }).join('');
    }
    function show() {
      var v = current, l = noteLang, r = rowOf(v), body = $('notes-body'), fellBack = false;
      chrome();
      $('notes-ver').textContent = 'GearMod ' + v;
      $('notes-date').textContent = r ? date(r.published_at || r.created_at) : '';
      $('notes-gh').href = r ? r.html_url : 'https://github.com/' + REPO + '/releases';
      body.innerHTML = '<p class="notes-wait">' + L[l].loading + '</p>';
      $('notes-jump').innerHTML = '';
      get(v, l).catch(function () { if (l !== 'pt') throw new Error('missing'); fellBack = true; return get(v, 'en'); })
        .then(function (src) {
          if (current !== v || noteLang !== l) return;
          body.innerHTML = (fellBack ? '<div class="notes-fallback">' + L.pt.fallback + '</div>' : '') + md(src);
          body.scrollTop = 0;
          $('notes-jump').innerHTML = Array.prototype.map.call(body.querySelectorAll('h3'), function (h) { return '<button type="button" data-jump="' + h.id + '">' + esc(h.textContent) + '</button>'; }).join('');
          $('notes-jump').scrollLeft = 0;
          spied = null; spy(); fades();
        })
        .catch(function () {
          if (current !== v || noteLang !== l) return;
          body.innerHTML = '<p class="notes-wait">' + L[l].missing + ' <a href="' + esc($('notes-gh').href) + '" target="_blank" rel="noopener">' + L[lang()].github + '</a></p>';
        });
    }
    function open(v) {
      if (!dlg) { var r = rowOf(v); location.href = r ? r.html_url : 'https://github.com/' + REPO + '/releases'; return; }
      current = v || (rows[0] && versionOf(rows[0]));
      if (!current) return;
      if (!opened) noteLang = lang();
      opened = true;
      show();
      if (!dlg.open) { dlg.showModal(); document.body.classList.add('noscroll'); }
      try { history.replaceState(null, '', '#notes-' + current); } catch (e) {}
    }
    /* Section bar: marks the section being read and keeps its chip in view. */
    var spied = null;
    function spy() {
      var body = $('notes-body'), bar = $('notes-jump'), heads = body.querySelectorAll('h3'), id = heads.length ? heads[0].id : null;
      if (!heads.length) return;
      var atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
      Array.prototype.forEach.call(heads, function (h) { if (h.offsetTop - body.scrollTop <= 60) id = h.id; });
      if (atEnd) id = heads[heads.length - 1].id;
      if (id === spied) return;
      spied = id;
      var chip = null;
      bar.querySelectorAll('button').forEach(function (b) { var on = b.dataset.jump === id; b.setAttribute('aria-current', String(on)); if (on) chip = b; });
      if (chip && !dragged) bar.scrollTo({ left: chip.offsetLeft - (bar.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
    }
    /* Faded edges show there is more to the side. */
    function fades() {
      var bar = $('notes-jump');
      bar.classList.toggle('more-left', bar.scrollLeft > 2);
      bar.classList.toggle('more-right', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2);
    }
    var dragged = false;
    if (dlg) {
      var bar = $('notes-jump');
      $('notes-body').addEventListener('scroll', spy, { passive: true });
      bar.addEventListener('scroll', fades, { passive: true });
      window.addEventListener('resize', function () { if (dlg.open) fades(); });
      /* The mouse wheel scrolls the bar sideways. */
      bar.addEventListener('wheel', function (e) {
        if (bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        bar.scrollLeft += e.deltaY;
      }, { passive: false });
      /* Dragging with the mouse scrolls it too (touch already scrolls natively). */
      var drag = null;
      bar.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        drag = { x: e.clientX, left: bar.scrollLeft, id: e.pointerId }; dragged = false;
      });
      bar.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = e.clientX - drag.x;
        if (!dragged && Math.abs(dx) > 5) { dragged = true; bar.classList.add('dragging'); try { bar.setPointerCapture(drag.id); } catch (err) {} }
        if (dragged) bar.scrollLeft = drag.left - dx;
      });
      function endDrag() { drag = null; bar.classList.remove('dragging'); setTimeout(function () { dragged = false; }, 0); }
      bar.addEventListener('pointerup', endDrag);
      bar.addEventListener('pointercancel', endDrag);
      /* A drag does not count as a click on a chip. */
      bar.addEventListener('click', function (e) { if (dragged) { e.stopPropagation(); e.preventDefault(); } }, true);
    }
    if (dlg) {
      dlg.addEventListener('close', function () { opened = false; document.body.classList.remove('noscroll'); try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} });
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) { dlg.close(); return; }
        var b = e.target.closest('button'); if (!b) return;
        if (b.id === 'notes-close') dlg.close();
        else if (b.dataset.noteLang) { noteLang = b.dataset.noteLang; show(); }
        else if (b.dataset.noteVer) { current = b.dataset.noteVer; show(); try { history.replaceState(null, '', '#notes-' + current); } catch (e2) {} }
        else if (b.dataset.jump) { var h = $(b.dataset.jump), body = $('notes-body'); if (h) body.scrollTo({ top: h.offsetTop - 12, behavior: 'smooth' }); }
      });
    }
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-notes]');
      if (!b || !b.dataset.notes) return;
      e.preventDefault(); open(b.dataset.notes);
    });
    return {
      ready: function (r) {
        rows = r;
        var m = /^#notes-(.+)$/.exec(location.hash);
        if (m && !opened) open(decodeURIComponent(m[1]));
        else if (dlg && dlg.open) chrome();
      }
    };
  })();

  /* Tabs only for platforms with files; the visitor's system wins when it has them, otherwise Windows. */
  var rowsSeen = [];
  function paintPlatforms(rows) {
    rowsSeen = rows;
    var available = Object.keys(MAIN).filter(function (os) { return latestFor(rows, os); });
    document.querySelectorAll('[data-os-tab]').forEach(function (b) { b.hidden = available.indexOf(b.dataset.osTab) < 0; });
    // The macOS chip under the hero appears with the first release that has the Mac disk images.
    document.querySelectorAll('.js-mac').forEach(function (el) { el.hidden = available.indexOf('mac') < 0; });
    var os = available.indexOf(wanted) >= 0 ? wanted : 'windows';
    root.dataset.os = os;
    document.querySelectorAll('.js-os').forEach(function (el) { el.textContent = NAMES[os]; });
    var r = latestFor(rows, os);
    if (r) {
      var main = assetOf(r, MAIN[os]);
      document.querySelectorAll('.js-dl').forEach(function (el) { el.href = main.browser_download_url; });
      document.querySelectorAll('[data-latest-version]').forEach(function (el) { el.textContent = r.tag_name; });
    }
    if (available.indexOf(root.dataset.dl) < 0 || !paintPlatforms.done) { paintPlatforms.done = true; selectTab(os); } else paintVersion();
  }

  /* Version line and buttons of the open tab. */
  function paintVersion() {
    var os = root.dataset.dl, r = latestFor(rowsSeen, os);
    if (!r || !$('dl-ver')) return;
    var main = assetOf(r, MAIN[os]);
    $('dl-ver').textContent = r.tag_name + ' · ' + date(r.published_at || r.created_at) + ' · ' + mb(main.size);
    $('dl-notes').href = r.html_url; $('dl-notes').dataset.notes = versionOf(r);
    var links = { 'dl-btn': assetOf(r, 'windows'), 'dl-appimage': assetOf(r, 'appimage'), 'dl-deb': assetOf(r, 'deb'), 'dl-dmg': assetOf(r, 'mac'), 'dl-dmg-intel': assetOf(r, 'macintel') };
    Object.keys(links).forEach(function (id) { if (links[id]) $(id).href = links[id].browser_download_url; });
  }

  /* The version list comes with the site (releases.json, written by the Pages deploy after each Release), so visitors do not
     depend on the GitHub API, which allows 60 requests/hour per IP without a login. The API is only the fallback (local preview,
     or a deploy that has no list yet), cached for 10 min. */
  function json(url, options) { return fetch(url, options).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function fromApi() {
    var key = 'gm-releases', now = Date.now();
    try { var c = JSON.parse(sessionStorage.getItem(key) || 'null'); if (c && now - c.t < 600000) return Promise.resolve(c.d); } catch (e) {}
    return json('https://api.github.com/repos/' + REPO + '/releases?per_page=30', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (d) { try { sessionStorage.setItem(key, JSON.stringify({ t: now, d: d })); } catch (e) {} return d; });
  }
  function load() {
    json('releases.json', { cache: 'no-cache' })
      .then(function (d) { if (!Array.isArray(d) || !d.length) throw new Error('empty'); return d; })
      .catch(fromApi)
      .then(function (d) { releases = d; renderReleases(); })
      .catch(function () { releases = false; if ($('dl-ver')) $('dl-ver').textContent = ''; renderReleases(); });
  }
  load();
})();
