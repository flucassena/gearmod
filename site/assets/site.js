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
    en: { latest: 'Latest', pre: 'Pre-release', dl: 'Download', notes: 'Notes', sums: 'SHA-256', none: 'No release published yet. Check back soon, or build from source (see the README).', fail: 'Could not load the version list. Open the releases page on GitHub.', all: 'See on GitHub', count: function (n) { return n + (n === 1 ? ' version' : ' versions'); }, kinds: { windows: 'Windows', appimage: 'AppImage', deb: '.deb', mac: 'macOS (Apple Silicon)', macintel: 'macOS (Intel)' } },
    pt: { latest: 'Mais recente', pre: 'Pré-release', dl: 'Baixar', notes: 'Notas', sums: 'SHA-256', none: 'Nenhuma release publicada ainda. Volte em breve, ou compile do código-fonte (veja o README).', fail: 'Não deu para carregar a lista de versões. Abra a página de releases no GitHub.', all: 'Ver no GitHub', count: function (n) { return n + (n === 1 ? ' versão' : ' versões'); }, kinds: { windows: 'Windows', appimage: 'AppImage', deb: '.deb', mac: 'macOS (Apple Silicon)', macintel: 'macOS (Intel)' } }
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

  function renderReleases() {
    var t = T[lang()], list = $('rel-list');
    if (releases === null) return;
    if (releases === false) { if (!list) return; list.innerHTML = '<div class="rel-empty">' + t.fail + ' <a href="https://github.com/' + REPO + '/releases">' + t.all + '</a></div>'; return; }
    var rows = releases.filter(function (r) { return !r.draft && hasAny(r); });
    if ($('rel-count')) $('rel-count').textContent = rows.length ? t.count(rows.length) : '';
    if (!rows.length) { if (list) list.innerHTML = '<div class="rel-empty">' + t.none + '</div>'; return; }
    var firstStable = rows.filter(function (r) { return !r.prerelease; })[0] || rows[0];
    if (list) list.innerHTML = rows.map(function (r) {
      var sums = sumsOf(r);
      var badge = r.id === firstStable.id ? '<span class="badge">' + t.latest + '</span>' : (r.prerelease ? '<span class="badge pre">' + t.pre + '</span>' : '');
      var files = Object.keys(KINDS).map(function (kind) {
        var a = assetOf(r, kind);
        return a ? '<a class="btn small' + '' + '" href="' + esc(a.browser_download_url) + '" title="' + esc(a.name) + ' · ' + mb(a.size) + '">' + t.kinds[kind] + '</a>' : '';
      }).join('');
      return '<div class="rel-item"><div class="v">' + esc(r.name || r.tag_name) + badge + '</div>' +
        '<div class="d">' + date(r.published_at || r.created_at) + '</div>' +
        '<div class="a">' + files +
        (sums ? '<a class="btn small" href="' + esc(sums.browser_download_url) + '">' + t.sums + '</a>' : '') +
        '<a class="btn small" href="' + esc(r.html_url) + '">' + t.notes + '</a></div></div>';
    }).join('');
    paintPlatforms(rows);
  }

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
    $('dl-notes').href = r.html_url;
    var links = { 'dl-btn': assetOf(r, 'windows'), 'dl-appimage': assetOf(r, 'appimage'), 'dl-deb': assetOf(r, 'deb'), 'dl-dmg': assetOf(r, 'mac'), 'dl-dmg-intel': assetOf(r, 'macintel') };
    Object.keys(links).forEach(function (id) { if (links[id]) $(id).href = links[id].browser_download_url; });
  }

  /* cache for 10 min: the unauthenticated API allows 60 requests/hour per IP */
  function load() {
    var key = 'gm-releases', now = Date.now();
    try { var c = JSON.parse(sessionStorage.getItem(key) || 'null'); if (c && now - c.t < 600000) { releases = c.d; return renderReleases(); } } catch (e) {}
    fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=30', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { releases = d; try { sessionStorage.setItem(key, JSON.stringify({ t: now, d: d })); } catch (e) {} renderReleases(); })
      .catch(function () { releases = false; if ($('dl-ver')) $('dl-ver').textContent = ''; renderReleases(); });
  }
  load();
})();
