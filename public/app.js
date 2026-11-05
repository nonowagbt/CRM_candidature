'use strict';

// Ordre des colonnes (logique du parcours)
const STATUTS = {
  postule:         { label: 'Postulé',               icon: '📨' },
  repondu:         { label: 'Réponse reçue',         icon: '💬' },
  entretien:       { label: 'Entretien',             icon: '🎙️' },
  retenu:          { label: 'Retenu',                icon: '🏆' },
  refus_entretien: { label: 'Refus après entretien', icon: '🟧' },
  refus_direct:    { label: 'Refus sans entretien',  icon: '✋' },
  cloture:         { label: 'Clôturé / sans suite',  icon: '🔒' },
};
// Ordre de la barre pipeline : choisi pour que deux couleurs voisines restent bien distinctes.
const BAR_ORDER = ['retenu', 'entretien', 'repondu', 'postule', 'refus_entretien', 'cloture', 'refus_direct'];
const CANAUX = ['Email', 'Indeed', 'Hellowork', 'LinkedIn', 'Welcome to the Jungle', 'Site carrière', 'Autre plateforme', 'En personne', 'Téléphone'];
const TYPES = ['Stage', 'Alternance', 'CDI', 'CDD', 'Freelance', 'Spontanée'];

const color = (s) => `var(--s-${s})`;
let items = [];
let view = localStorage.getItem('crm-view') || 'board';
let statutFilter = '';
let kpiFilter = '';
// Filtres déclenchés par les cartes KPI
const KPI_FILTERS = {
  recent:     { label: 'Envoyées ces 30 derniers jours', test: (c) => daysSince(c.dateCandidature) <= 30 },
  repondues:  { label: 'Entreprises qui ont répondu',    test: (c) => c.statut !== 'postule' },
  entretiens: { label: 'Entretiens décrochés',           test: (c) => ['entretien', 'retenu', 'refus_entretien'].includes(c.statut) || !!c.dateEntretien },
  attente:    { label: 'En attente de réponse',          test: (c) => c.statut === 'postule' },
  relance:    { label: 'À relancer',                     test: (c) => needsRelance(c) },
};
let sort = { key: 'dateCandidature', asc: false };
let editingId = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d + 'T00:00:00')) / 864e5) : 0);
const mapsUrl = (a) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
const gmailUrl = (t) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(t)}`;
const isTodo = (c) => /à compléter|à confirmer/.test(c.entreprise || '');
const lastContact = (c) => (c.derniereRelance && c.derniereRelance > (c.dateCandidature || '') ? c.derniereRelance : c.dateCandidature);
const needsRelance = (c) => ['postule', 'repondu'].includes(c.statut) && daysSince(lastContact(c)) >= relanceJours();
const firstEmail = (c) => (c.email || '').split(',').map((e) => e.trim()).filter(Boolean);
let config = { gmail: false, gmailUser: '', hasPassword: false, senderName: '', titre: 'Mes candidatures', tagline: '', pitch: '', signature: '', relanceJours: 21 };
let me = { email: '' };
const relanceJours = () => +config.relanceJours || 21;

async function api(method, url, body) {
  // Toute écriture envoie du JSON (le serveur l'exige, c'est sa protection anti-CSRF), même sans contenu.
  const write = method !== 'GET' && method !== 'DELETE';
  const res = await fetch(url, {
    method,
    headers: write ? { 'Content-Type': 'application/json' } : {},
    body: write ? JSON.stringify(body ?? {}) : undefined,
  });
  if (res.status === 401) { location.replace('/login.html'); throw new Error('Session expirée, reconnecte-toi'); }
  if (!res.ok && res.status !== 204) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function toast(msg, link) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">Ouvrir les brouillons ↗</a>` : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, link ? 6000 : 2200);
}

const options = (list, empty) => (empty ? `<option value="">${empty}</option>` : '') + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');

function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const fc = $('#filter-canal').value, ft = $('#filter-type').value;
  return items
    .filter((c) => (!fc || c.canal === fc) && (!ft || c.type === ft))
    .filter((c) => !kpiFilter || KPI_FILTERS[kpiFilter].test(c))
    .filter((c) => !q || ['entreprise', 'poste', 'email', 'contact', 'notes', 'canal', 'adresse'].some((k) => (c[k] || '').toLowerCase().includes(q)))
    .sort((a, b) => {
      const va = (a[sort.key] || '').toLowerCase(), vb = (b[sort.key] || '').toLowerCase();
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.asc ? 1 : -1);
    });
}

function renderKpis() {
  const n = items.length;
  const count = (k) => items.filter(KPI_FILTERS[k].test).length;
  const repondues = count('repondues'), entretiens = count('entretiens'), attente = count('attente');
  const relances = count('relance'), ceMois = count('recent');
  const retenus = items.filter((c) => c.statut === 'retenu').length;
  // key = filtre appliqué au clic sur la carte ('' = tout afficher) ; subKey = filtre du lien sous le chiffre
  const kpi = (key, label, value, sub, accent, subKey) => {
    const active = key ? kpiFilter === key : !kpiFilter && !statutFilter;
    const subHtml = subKey
      ? `<button class="kpi-sub ${kpiFilter === subKey ? 'on' : ''}" data-kpi="${subKey}">${sub} →</button>`
      : `<div class="s">${sub}</div>`;
    return `<div class="kpi ${active ? 'active' : ''}" role="button" tabindex="0" data-kpi="${key}" style="--accent:${accent}"
      title="${key ? 'Filtrer : ' + esc(KPI_FILTERS[key].label) : 'Tout afficher'}">
      <div class="l">${label}</div><div class="n">${value}</div>${subHtml}</div>`;
  };
  $('#kpis').innerHTML =
    kpi('', 'Candidatures envoyées', n, `+${ceMois} ces 30 derniers jours`, 'var(--grad)', ceMois ? 'recent' : '') +
    kpi('repondues', 'Taux de réponse', `${n ? Math.round((repondues / n) * 100) : 0}%`, `${repondues} entreprises ont répondu`, color('repondu')) +
    kpi('entretiens', 'Entretiens décrochés', entretiens, retenus ? `${retenus} retenu(s) 🏆` : 'Prochaine étape : le oui 💪', color('entretien')) +
    kpi('attente', 'En attente', attente, 'Pas encore de réponse', color('postule')) +
    kpi('relance', '⏰ À relancer', relances, relances ? `Sans nouvelles depuis +${relanceJours()} j · clique puis ↻` : 'Tout est à jour 👌', color('refus_entretien'));
}

function renderPipeline() {
  const counts = Object.fromEntries(Object.keys(STATUTS).map((k) => [k, 0]));
  items.forEach((c) => { counts[c.statut] = (counts[c.statut] || 0) + 1; });
  const total = items.length || 1;
  const bar = $('#bar');
  bar.classList.toggle('filtering', !!statutFilter);
  bar.innerHTML = BAR_ORDER.filter((k) => counts[k]).map((k) =>
    `<div class="seg-s ${statutFilter === k ? 'on' : ''}" data-statut="${k}" data-tip="${esc(STATUTS[k].label)} : ${counts[k]} (${Math.round((counts[k] / total) * 100)}%)" style="--c:${color(k)};flex:${counts[k]}"></div>`).join('');
  $('#legend').innerHTML = BAR_ORDER.map((k) =>
    `<button class="${statutFilter === k ? 'on' : ''}" data-statut="${k}" style="--c:${color(k)}"><span class="dot"></span>${esc(STATUTS[k].label)} <b>${counts[k]}</b></button>`).join('');
  const active = statutFilter ? STATUTS[statutFilter].label : kpiFilter ? KPI_FILTERS[kpiFilter].label : '';
  $('#pipeline-sub').innerHTML = active
    ? `Filtré : <b>${esc(active)}</b> · <button class="link" id="clear-filter">Tout afficher</button>`
    : 'Clique sur un statut ou une carte pour filtrer';
}

function cardHtml(c) {
  const chips = [
    c.dateCandidature && `<span>${fmtDate(c.dateCandidature)}</span>`,
    c.canal && `<span class="chip ${c.canal === 'En personne' ? 'phys' : ''}">${c.canal === 'En personne' ? '🤝 ' : ''}${esc(c.canal)}</span>`,
    c.type && `<span class="chip">${esc(c.type)}</span>`,
    needsRelance(c) && `<span class="chip warn">⏰ À relancer</span>`,
    c.brouillonRelance && `<span class="chip draft" title="Créé le ${fmtDate(c.brouillonRelance)} — envoie-le depuis Gmail">✏️ Brouillon à envoyer</span>`,
    c.derniereRelance && `<span class="chip done">↻ Relancé ${fmtDate(c.derniereRelance)}${+c.nbRelances > 1 ? ` (×${c.nbRelances})` : ''}</span>`,
    isTodo(c) && `<span class="chip todo">✎ À compléter</span>`,
    c.dateEntretien && `<span class="chip">🎙️ ${fmtDate(c.dateEntretien)}</span>`,
  ].filter(Boolean).join('');
  return `<article class="card" draggable="true" data-id="${esc(c.id)}" style="--c:${color(c.statut)}">
    <div class="links">
      ${firstEmail(c).length ? `<button class="icon relance" data-relance="${esc(c.id)}" title="Créer un brouillon de relance dans Gmail">↻</button>` : ''}
      ${c.email ? `<a class="icon" href="mailto:${esc(c.email.split(',')[0].trim())}" title="Écrire à ${esc(c.email)}">@</a>` : ''}
      ${c.thread ? `<a class="icon" href="${gmailUrl(c.thread)}" target="_blank" rel="noopener" title="Ouvrir le fil Gmail">✉</a>` : ''}
      ${c.lienOffre ? `<a class="icon" href="${esc(c.lienOffre)}" target="_blank" rel="noopener" title="Voir l'offre">↗</a>` : ''}
      ${c.adresse ? `<a class="icon" href="${mapsUrl(c.adresse)}" target="_blank" rel="noopener" title="${esc(c.adresse)}">📍</a>` : ''}
    </div>
    <div class="ent">${esc(c.entreprise)}</div>
    <div class="pos">${esc(c.poste)}</div>
    <div class="meta">${chips}</div>
  </article>`;
}

function renderBoard(rows) {
  const keys = statutFilter ? [statutFilter]
    : kpiFilter ? Object.keys(STATUTS).filter((k) => rows.some((c) => c.statut === k))
    : Object.keys(STATUTS);
  $('#board').innerHTML = keys.map((k) => {
    const col = rows.filter((c) => c.statut === k);
    return `<section class="col" data-statut="${k}" style="--c:${color(k)}">
      <div class="col-head"><span class="dot"></span>${STATUTS[k].icon} ${esc(STATUTS[k].label)}<span class="count">${col.length}</span></div>
      <div class="col-body">${col.map(cardHtml).join('')}</div>
    </section>`;
  }).join('');
}

function renderList(rows) {
  rows = statutFilter ? rows.filter((c) => c.statut === statutFilter) : rows;
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sort.key);
    th.classList.toggle('asc', th.dataset.sort === sort.key && sort.asc);
  });
  $('#list tbody').innerHTML = rows.map((c) => {
    const emails = (c.email || '').split(',').map((e) => e.trim()).filter(Boolean).map((e) => `<a class="mail" href="mailto:${esc(e)}">${esc(e)}</a>`).join('<br>');
    return `<tr data-id="${esc(c.id)}">
      <td class="date">${fmtDate(c.dateCandidature)}</td>
      <td><div class="ent">${esc(c.entreprise)}</div><div class="sub">${esc(c.type || '')}</div></td>
      <td>${esc(c.poste)}${c.notes ? `<div class="sub">${esc(c.notes)}</div>` : ''}</td>
      <td><span class="chip">${esc(c.canal)}</span></td>
      <td>${emails}${c.contact ? `<div class="sub">${esc(c.contact)}</div>` : ''}${c.adresse ? `<div class="sub"><a class="mail" href="${mapsUrl(c.adresse)}" target="_blank" rel="noopener">📍 ${esc(c.adresse)}</a></div>` : ''}</td>
      <td><label class="statut-select" style="--c:${color(c.statut)}"><span class="dot"></span>
        <select data-statut-id="${esc(c.id)}" aria-label="Statut de ${esc(c.entreprise)}">
          ${Object.entries(STATUTS).map(([k, v]) => `<option value="${k}" ${k === c.statut ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
        </select></label></td>
      <td class="act">${c.thread ? `<a class="icon" href="${gmailUrl(c.thread)}" target="_blank" rel="noopener" title="Gmail">✉</a>` : ''}${firstEmail(c).length ? `<button class="icon relance" data-relance="${esc(c.id)}" title="Créer un brouillon de relance dans Gmail">↻</button>` : ''}<button class="icon edit" data-id="${esc(c.id)}" title="Modifier">✎</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Aucune candidature.</td></tr>`;
}

// ---------- Graphique : candidatures envoyées par période, empilées selon leur issue ----------
const CHART_SERIES = [ // de bas en haut (ordre validé pour que deux couleurs voisines restent distinctes)
  { key: 'positif', label: 'Réponse / entretien', color: 'var(--s-repondu)', statuts: ['repondu', 'entretien', 'retenu'] },
  { key: 'attente', label: 'En attente', color: 'var(--s-postule)', statuts: ['postule'] },
  { key: 'refus', label: 'Refus / clôturé', color: 'var(--s-refus_direct)', statuts: ['refus_entretien', 'refus_direct', 'cloture'] },
];
let chartRange = localStorage.getItem('crm-chart-range') || '3m';

const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const startOfMonth = (d) => { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), 1); };

function chartBuckets() {
  const dated = items.filter((c) => c.dateCandidature).map((c) => ({ c, d: new Date(c.dateCandidature + 'T00:00:00') }));
  const now = new Date();
  const weeksBack = chartRange === '3m' ? 13 : 26;
  const oldest = dated.reduce((m, x) => (x.d < m ? x.d : m), now);
  const monthly = chartRange === 'all' && (now - oldest) / 864e5 > 26 * 7;
  const step = monthly ? startOfMonth : startOfWeek;
  const start = chartRange === 'all' ? step(oldest) : startOfWeek(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weeksBack - 1) * 7));
  const buckets = [];
  // Avance par date calendaire (et non +7×24 h) pour rester juste au changement d'heure.
  for (let b = new Date(start); b <= now; b = monthly ? new Date(b.getFullYear(), b.getMonth() + 1, 1) : new Date(b.getFullYear(), b.getMonth(), b.getDate() + 7)) {
    buckets.push({ start: new Date(b), positif: 0, attente: 0, refus: 0, total: 0 });
  }
  for (const { c, d } of dated) {
    if (d < start) continue;
    const key = step(d).getTime();
    const bucket = buckets.find((x) => x.start.getTime() === key);
    const serie = CHART_SERIES.find((s) => s.statuts.includes(c.statut));
    if (bucket && serie) { bucket[serie.key]++; bucket.total++; }
  }
  return { buckets, monthly };
}

const bucketLabel = (b, monthly, long) => monthly
  ? b.start.toLocaleDateString('fr-FR', { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' })
  : (long ? 'Semaine du ' : '') + b.start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = [1, 2, 2.5, 5, 10].find((m) => m * pow >= v);
  return n * pow;
}

function renderChart() {
  const el = $('#chart');
  const { buckets, monthly } = chartBuckets();
  const W = Math.max(280, el.clientWidth || 800), H = 190;
  const m = { top: 18, right: 8, bottom: 24, left: 30 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(1, ...buckets.map((b) => b.total)));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max].filter((t) => Number.isInteger(t));
  const y = (v) => m.top + ih - (v / max) * ih;
  const band = iw / Math.max(1, buckets.length);
  const bw = Math.min(24, band * 0.62);
  const GAP = 2;
  const total = buckets.reduce((s, b) => s + b.total, 0);
  const peak = buckets.reduce((best, b) => (b.total > (best?.total || 0) ? b : best), null);
  // Étiquettes de l'axe X : une sur n pour qu'elles ne se chevauchent pas (~46px chacune)
  const every = Math.max(1, Math.ceil(46 / band));

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" aria-hidden="true">`;
  for (const t of ticks) {
    svg += `<line x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`;
    svg += `<text x="${m.left - 8}" y="${y(t) + 4}" class="tick" text-anchor="end">${t}</text>`;
  }
  buckets.forEach((b, i) => {
    const cx = m.left + band * i + band / 2, x = cx - bw / 2;
    let base = 0;
    const segs = CHART_SERIES.filter((s) => b[s.key] > 0);
    segs.forEach((s, j) => {
      const y0 = y(base), y1 = y(base + b[s.key]);
      const top = j === segs.length - 1;
      const h = Math.max(1, y0 - y1 - (j > 0 ? GAP : 0));   // 2px d'air entre deux segments
      const yb = y0 - (j > 0 ? GAP : 0);
      const r = top ? Math.min(4, h, bw / 2) : 0;          // bout arrondi, base carrée
      svg += `<path fill="${s.color}" d="M${x},${yb} V${yb - h + r} Q${x},${yb - h} ${x + r},${yb - h} H${x + bw - r} Q${x + bw},${yb - h} ${x + bw},${yb - h + r} V${yb} Z"/>`;
      base += b[s.key];
    });
    if (b === peak && b.total > 0) svg += `<text x="${cx}" y="${y(b.total) - 6}" class="peak" text-anchor="middle">${b.total}</text>`;
    if (i % every === 0) svg += `<text x="${cx}" y="${H - 6}" class="tick" text-anchor="middle">${esc(bucketLabel(b, monthly))}</text>`;
    // zone de survol plus large que la barre
    svg += `<rect x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ih}" class="hit" data-i="${i}"/>`;
  });
  svg += `<line x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}" class="axis"/></svg>`;
  el.innerHTML = svg;
  el._buckets = buckets; el._monthly = monthly;

  const label = monthly ? 'par mois' : 'par semaine';
  const periode = chartRange === '3m' ? 'sur 3 mois' : chartRange === '6m' ? 'sur 6 mois' : 'au total';
  $('#chart-sub').textContent = `${total} candidature${total > 1 ? 's' : ''} ${periode}, ${label}${peak && peak.total ? ` · record : ${peak.total} (${bucketLabel(peak, monthly, true).toLowerCase()})` : ''}`;
  el.setAttribute('aria-label', `Candidatures envoyées ${label} : ${total} au total. Détail dans « Voir les données ».`);
  $('#chart-legend').innerHTML = CHART_SERIES.map((s) => `<span><i class="key" style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  document.querySelectorAll('#chart-range button').forEach((b) => b.classList.toggle('on', b.dataset.range === chartRange));
  $('#chart-table').innerHTML = `<thead><tr><th>${monthly ? 'Mois' : 'Semaine'}</th>${CHART_SERIES.map((s) => `<th>${esc(s.label)}</th>`).join('')}<th>Total</th></tr></thead><tbody>` +
    buckets.map((b) => `<tr><td>${esc(bucketLabel(b, monthly, true))}</td>${CHART_SERIES.map((s) => `<td>${b[s.key]}</td>`).join('')}<td><b>${b.total}</b></td></tr>`).join('') + '</tbody>';
}

function bindChart() {
  const el = $('#chart'), tip = $('#tooltip');
  el.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.hit');
    el.querySelectorAll('.hit.on').forEach((h) => h !== hit && h.classList.remove('on'));
    if (!hit) { tip.hidden = true; return; }
    hit.classList.add('on');
    const b = el._buckets[+hit.dataset.i];
    tip.innerHTML = `<b>${esc(bucketLabel(b, el._monthly, true))}</b><br>${b.total} candidature${b.total > 1 ? 's' : ''}` +
      CHART_SERIES.filter((s) => b[s.key]).map((s) => `<br><i class="key" style="background:${s.color}"></i>${esc(s.label)} : ${b[s.key]}`).join('');
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 220)}px`;
    tip.style.top = `${e.clientY - 70}px`;
  });
  el.addEventListener('mouseleave', () => { tip.hidden = true; el.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on')); });
  $('#chart-range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b) return;
    chartRange = b.dataset.range; localStorage.setItem('crm-chart-range', chartRange); renderChart();
  });
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(renderChart, 120); });
}

function render() {
  renderKpis();
  renderChart();
  renderPipeline();
  const rows = filtered();
  $('#board').hidden = view !== 'board';
  $('#list').hidden = view !== 'list';
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  view === 'board' ? renderBoard(rows) : renderList(rows);
}

// Remplit la date de réponse / d'entretien quand le statut avance.
function autoDates(item, statut) {
  const patch = { statut };
  if (statut !== 'postule' && !item.dateReponse) patch.dateReponse = today();
  if (statut === 'entretien' && !item.dateEntretien) patch.dateEntretien = today();
  return patch;
}

async function setStatut(id, statut) {
  const item = items.find((c) => c.id === id);
  if (!item || item.statut === statut) return;
  Object.assign(item, await api('PUT', `/api/candidatures/${id}`, autoDates(item, statut)));
  render();
  toast(`${item.entreprise} → ${STATUTS[statut].icon} ${STATUTS[statut].label}`);
}

function renderStatusPick(current) {
  $('#form [name="statut"]').value = current;
  $('#status-pick').innerHTML = Object.entries(STATUTS).map(([k, v]) =>
    `<button type="button" data-statut="${k}" class="${k === current ? 'on' : ''}" style="--c:${color(k)}"><span class="dot"></span>${esc(v.label)}</button>`).join('');
}

// Le champ adresse n'apparaît que pour une candidature en personne (ou s'il est déjà rempli).
function toggleAdresse() {
  const canal = $('#form [name="canal"]').value;
  $('#lbl-adresse').hidden = canal !== 'En personne' && !$('#form [name="adresse"]').value;
}

function openForm(item, preset) {
  editingId = item?.id || null;
  const f = $('#form');
  f.reset();
  $('#form-title').textContent = item ? item.entreprise : 'Nouvelle candidature';
  $('#btn-delete').style.display = item ? '' : 'none';
  $('#btn-relance').style.display = item && firstEmail(item).length ? '' : 'none';
  const data = item || { statut: 'postule', canal: 'Email', type: 'Stage', dateCandidature: today(), ...preset };
  for (const el of f.elements) if (el.name) el.value = data[el.name] || '';
  renderStatusPick(data.statut || 'postule');
  toggleAdresse();
  $('#dialog').showModal();
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

function exportCsv() {
  // Titres en français + dates JJ/MM/AAAA + « ; » : s'ouvre proprement dans Excel FR, et se réimporte tel quel.
  const cols = [['dateCandidature', 'Date de candidature'], ['entreprise', 'Entreprise'], ['poste', 'Poste'], ['type', 'Type'], ['canal', 'Canal'],
    ['email', 'Email'], ['contact', 'Contact'], ['statut', 'Statut'], ['dateReponse', 'Date de réponse'], ['dateEntretien', "Date d'entretien"],
    ['lienOffre', "Lien de l'offre"], ['adresse', 'Adresse'], ['notes', 'Notes']];
  const frDay = (d) => (d ? d.split('-').reverse().join('/') : '');
  const value = (c, k) => (k === 'statut' ? STATUTS[c.statut]?.label : k.startsWith('date') ? frDay(c[k]) : c[k]);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(([, l]) => cell(l)).join(';'), ...filtered().map((c) => cols.map(([k]) => cell(value(c, k))).join(';'))];
  download(`candidatures-${today()}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function bindDragAndDrop() {
  const board = $('#board');
  let dragId = null;
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    dragId = card.dataset.id; card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  board.addEventListener('dragend', (e) => { e.target.closest('.card')?.classList.remove('dragging'); });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.col'); if (!col || !dragId) return;
    e.preventDefault();
    board.querySelectorAll('.col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
    col.classList.add('drop');
  });
  board.addEventListener('dragleave', (e) => { const col = e.target.closest('.col'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop'); });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.col'); if (!col || !dragId) return;
    e.preventDefault(); col.classList.remove('drop');
    setStatut(dragId, col.dataset.statut).catch((err) => alert(err.message));
    dragId = null;
  });
  board.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const rb = e.target.closest('[data-relance]');
    if (rb) return relancer(items.find((c) => c.id === rb.dataset.relance));
    const card = e.target.closest('.card');
    if (card) openForm(items.find((c) => c.id === card.dataset.id));
  });
}

function bind() {
  $('#filter-canal').innerHTML = options(CANAUX, 'Tous les canaux');
  $('#filter-type').innerHTML = options(TYPES, 'Tous les types');
  $('#form [name="canal"]').innerHTML = options(CANAUX);
  $('#form [name="type"]').innerHTML = options(TYPES);

  ['#search', '#filter-canal', '#filter-type'].forEach((s) => $(s).addEventListener('input', render));
  const pickStatut = (e) => {
    const el = e.target.closest('[data-statut]'); if (!el) return;
    statutFilter = statutFilter === el.dataset.statut ? '' : el.dataset.statut;
    kpiFilter = '';
    render();
  };
  const pickKpi = (e) => {
    const el = e.target.closest('[data-kpi]'); if (!el) return;
    e.stopPropagation();
    const key = el.dataset.kpi;
    kpiFilter = key && kpiFilter !== key ? key : '';
    statutFilter = '';
    render();
    if (kpiFilter) $('.toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#kpis').addEventListener('click', pickKpi);
  $('#kpis').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickKpi(e); } });
  $('#pipeline-sub').addEventListener('click', (e) => {
    if (e.target.id === 'clear-filter') { kpiFilter = ''; statutFilter = ''; render(); }
  });
  $('#bar').addEventListener('click', pickStatut);
  $('#legend').addEventListener('click', pickStatut);

  const tip = $('#tooltip');
  $('#bar').addEventListener('mousemove', (e) => {
    const s = e.target.closest('.seg-s'); if (!s) { tip.hidden = true; return; }
    tip.textContent = s.dataset.tip; tip.hidden = false;
    tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY - 36}px`;
  });
  $('#bar').addEventListener('mouseleave', () => { tip.hidden = true; });

  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view; localStorage.setItem('crm-view', view); render();
  }));
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    sort = { key: th.dataset.sort, asc: sort.key === th.dataset.sort ? !sort.asc : true };
    render();
  }));
  // Changement de statut directement depuis la liste
  $('#list').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-statut-id]');
    if (sel) setStatut(sel.dataset.statutId, sel.value).catch((err) => { alert(err.message); render(); });
  });
  $('#list').addEventListener('click', (e) => {
    const rb = e.target.closest('[data-relance]');
    if (rb) return relancer(items.find((c) => c.id === rb.dataset.relance));
    const btn = e.target.closest('.edit'); if (btn) openForm(items.find((c) => c.id === btn.dataset.id));
  });
  bindDragAndDrop();

  // menu ⋯
  $('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#menu-pop').hidden = !$('#menu-pop').hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('#menu-pop').hidden = true; });

  // formulaire
  $('#status-pick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-statut]'); if (b) renderStatusPick(b.dataset.statut);
  });
  $('#btn-add').addEventListener('click', () => openForm(null));
  $('#btn-add-physique').addEventListener('click', () => openForm(null, { canal: 'En personne', type: 'Spontanée', poste: 'Candidature spontanée – CV déposé sur place' }));
  $('#form [name="canal"]').addEventListener('change', toggleAdresse);
  $('#btn-cancel').addEventListener('click', () => $('#dialog').close());
  $('#btn-close').addEventListener('click', () => $('#dialog').close());
  $('#btn-delete').addEventListener('click', async () => {
    const item = items.find((c) => c.id === editingId);
    if (!item || !confirm(`Supprimer « ${item.entreprise} – ${item.poste || ''} » ?`)) return;
    await api('DELETE', `/api/candidatures/${editingId}`);
    items = items.filter((c) => c.id !== editingId);
    $('#dialog').close(); render(); toast('Candidature supprimée');
  });
  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (editingId) {
        const item = items.find((c) => c.id === editingId);
        if (data.statut !== item.statut) Object.assign(data, { ...autoDates(item, data.statut), ...Object.fromEntries(Object.entries(data).filter(([, v]) => v)) });
        Object.assign(item, await api('PUT', `/api/candidatures/${editingId}`, data));
        toast('Modifications enregistrées ✔');
      } else {
        items.push(await api('POST', '/api/candidatures', data));
        toast('Candidature ajoutée 🚀');
      }
      $('#dialog').close(); render();
    } catch (err) { alert(err.message); }
  });

  $('#btn-export-csv').addEventListener('click', exportCsv);
  $('#btn-export-json').addEventListener('click', () => download(`candidatures-${today()}.json`, JSON.stringify(items, null, 2), 'application/json'));
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm(`Remplacer les ${items.length} candidatures actuelles par les ${data.length} du fichier ?`)) return;
      await api('POST', '/api/import', data);
      items = await api('GET', '/api/candidatures');
      render(); toast('Import terminé');
    } catch (err) { alert('Import impossible : ' + err.message); }
    e.target.value = '';
  });
}


// ---------- Relances ----------
// Le texte s'appuie sur les ⚙️ Paramètres (nom, présentation, signature).
function buildRelance(c) {
  const contactName = (c.contact || '').split('(')[0].trim();
  const greeting = contactName ? `Bonjour ${contactName},` : 'Madame, Monsieur,';
  const isSpontanee = c.type === 'Spontanée' || /spontan/i.test(c.poste || '');
  const poste = (c.poste || '').replace(/^candidature spontanée\s*[–-]\s*/i, '').trim();
  const objet = isSpontanee
    ? `ma candidature spontanée${poste ? ` pour un ${poste.charAt(0).toLowerCase() + poste.slice(1)}` : ''}`
    : `ma candidature${poste ? ` au poste « ${poste} »` : ''}`;
  const quand = c.dateCandidature ? `, envoyée le ${new Date(c.dateCandidature + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}` : '';
  const dejaRelance = +c.nbRelances > 0;
  const entreprise = c.entreprise.replace(/\s*\(.*\)\s*$/, '');
  const subject = [dejaRelance ? 'Nouvelle relance' : 'Relance',
    isSpontanee ? 'Candidature spontanée' : `Candidature ${poste}`.trim(), config.senderName].filter(Boolean).join(' – ');
  const paragraphs = [
    greeting,
    `Je me permets de revenir vers vous au sujet de ${objet}${quand}.`,
    `Rejoindre ${entreprise} m'intéresse toujours beaucoup, et je souhaitais savoir si mon profil avait pu retenir votre attention.${config.pitch ? ' ' + config.pitch : ''}`,
    'Je reste à votre disposition pour un échange ou un entretien à votre convenance, et peux vous renvoyer mon CV si besoin.',
    'Je vous remercie par avance pour votre retour.',
    'Bien cordialement,',
    config.signature || config.senderName,
  ].filter(Boolean);
  return { to: firstEmail(c).join(', '), subject, body: paragraphs.join('\n\n') };
}

function openGmailCompose({ to, subject, body }) {
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank', 'noopener');
}

const DRAFTS_URL = 'https://mail.google.com/mail/u/0/#drafts';
const busy = new Set();

// Clic sur ↻ : crée directement le brouillon de relance dans Gmail.
async function relancer(c) {
  if (!c || busy.has(c.id)) return;
  const draft = buildRelance(c);
  if (!config.gmail) {
    // Gmail pas configuré : Gmail s'ouvre pré-rempli et enregistre le brouillon automatiquement.
    openGmailCompose(draft);
    toast('Relance ouverte dans Gmail — elle est enregistrée dans tes brouillons');
    return;
  }
  busy.add(c.id);
  toast(`Création du brouillon pour ${c.entreprise}…`);
  try {
    const res = await api('POST', `/api/candidatures/${c.id}/relance`, { to: draft.to, subject: draft.subject, body: draft.body });
    Object.assign(c, res);
    render();
    toast(`Brouillon créé${res.draft?.inThread ? ' dans le fil d\'origine' : ''} ✉️ — envoie-le depuis Gmail, l'appli se mettra à jour toute seule`, DRAFTS_URL);
  } catch (err) {
    alert(err.message);
  } finally {
    busy.delete(c.id);
  }
}

function bindRelance() {
  $('#btn-relance').addEventListener('click', () => {
    const c = items.find((x) => x.id === editingId);
    $('#dialog').close();
    relancer(c);
  });
}

// ---------- Paramètres ----------
function applyBranding() {
  const titre = (config.titre || 'Mes candidatures').trim();
  const i = titre.lastIndexOf(' ');
  // Le dernier mot du titre prend le dégradé.
  $('#app-title').innerHTML = i > 0 ? `${esc(titre.slice(0, i))} <span class="grad">${esc(titre.slice(i + 1))}</span>` : `<span class="grad">${esc(titre)}</span>`;
  $('#app-tagline').textContent = config.tagline || '';
  $('#app-tagline').hidden = !config.tagline;
  document.title = `${titre} · CRM`;
}

function renderGmailStatus() {
  const st = $('#gmail-status');
  if (config.gmail) {
    st.className = 'hint ok';
    st.innerHTML = `Connecté : les relances ↻ arrivent dans les brouillons de <b>${esc(config.gmailUser)}</b>.`;
  } else {
    st.className = 'hint warn';
    st.textContent = 'Pas encore configuré : en attendant, ↻ ouvre la relance pré-remplie dans Gmail.';
  }
  $('#settings-clear-pass').hidden = !config.hasPassword;
  $('#settings-form [name="gmailAppPassword"]').placeholder = config.hasPassword ? '•••• enregistré — laisse vide pour le garder' : 'xxxx xxxx xxxx xxxx';
}

function openSettings() {
  const f = $('#settings-form');
  for (const k of ['gmailUser', 'senderName', 'titre', 'tagline', 'pitch', 'signature', 'relanceJours']) {
    f.querySelector(`[name="${k}"]`).value = config[k] ?? '';
  }
  f.querySelector('[name="gmailAppPassword"]').value = '';
  const tr = $('#test-result'); tr.textContent = ''; tr.className = 'muted';
  $('#pwd-result').textContent = '';
  $('#account-line').textContent = `Connecté en tant que ${me.email}`;
  if (!config.gmailUser && /@gmail\.com$/.test(me.email)) f.querySelector('[name="gmailUser"]').value = me.email;
  renderGmailStatus();
  renderPlatforms();
  $('#settings-dialog').showModal();
}

function settingsFormData() {
  const data = Object.fromEntries(new FormData($('#settings-form')).entries());
  if (!data.gmailAppPassword) delete data.gmailAppPassword; // vide = on garde celui enregistré
  return data;
}

function bindSettings() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  $('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
  $('#settings-test').addEventListener('click', async () => {
    const tr = $('#test-result'), btn = $('#settings-test');
    const d = settingsFormData();
    btn.disabled = true; tr.className = 'muted'; tr.textContent = 'Connexion à Gmail…';
    try {
      const r = await api('POST', '/api/settings/test', { gmailUser: d.gmailUser, gmailAppPassword: d.gmailAppPassword });
      tr.className = 'ok';
      tr.textContent = `✔ Connexion réussie${r.drafts ? ` (dossier « ${r.drafts} »)` : ''} — pense à enregistrer`;
    } catch (err) {
      tr.className = 'err'; tr.textContent = '✖ ' + err.message;
    } finally { btn.disabled = false; }
  });
  $('#settings-clear-pass').addEventListener('click', async () => {
    if (!confirm('Effacer le mot de passe d\'application enregistré ?')) return;
    config = await api('PUT', '/api/settings', { clearPassword: true });
    renderGmailStatus(); toast('Mot de passe effacé');
  });
  $('#pwd-change').addEventListener('click', async () => {
    const out = $('#pwd-result');
    const current = $('#pwd-current').value, next = $('#pwd-next').value;
    if (next.length < 8) { out.className = 'err'; out.textContent = '8 caractères minimum'; return; }
    try {
      await api('POST', '/api/auth/password', { current, next });
      $('#pwd-current').value = ''; $('#pwd-next').value = '';
      out.className = 'ok'; out.textContent = '✔ Mot de passe changé (tes autres appareils sont déconnectés)';
    } catch (err) { out.className = 'err'; out.textContent = '✖ ' + err.message; }
  });
  $('#btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    location.replace('/login.html');
  });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      config = await api('PUT', '/api/settings', settingsFormData());
      applyBranding(); render();
      renderSyncLabel(null);
      if (config.gmail) syncNow({ manual: true });
      $('#settings-dialog').close();
      toast(config.gmail ? 'Paramètres enregistrés ✔ — relances vers tes brouillons Gmail' : 'Paramètres enregistrés ✔');
    } catch (err) { alert(err.message); }
  });
}

// ---------- Plateformes (Paramètres) ----------
const PLATFORM_LINKS = {
  LinkedIn: { icon: 'in', color: '#0a66c2', applied: 'https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED', notifs: 'https://www.linkedin.com/mypreferences/d/categories/notifications' },
  Indeed: { icon: 'i', color: '#2557a7', applied: 'https://myjobs.indeed.com/applied', notifs: 'https://secure.indeed.com/settings' },
  Hellowork: { icon: 'H', color: '#ff6a3d', applied: 'https://www.hellowork.com/fr-fr/candidat/mon-profil.html', notifs: 'https://www.hellowork.com/fr-fr/candidat/mon-profil.html' },
  'Welcome to the Jungle': { icon: 'W', color: '#ffcd00', applied: 'https://www.welcometothejungle.com/fr/me', notifs: 'https://www.welcometothejungle.com/fr/me' },
};

async function renderPlatforms() {
  const box = $('#platforms');
  let data;
  try { data = await api('GET', '/api/platforms'); } catch { box.textContent = ''; return; }
  box.innerHTML = data.platforms.map((p) => {
    const l = PLATFORM_LINKS[p.name];
    let status, cls;
    if (!data.gmail) { status = 'Gmail non connecté : renseigne-le ci-dessus pour suivre cette plateforme'; cls = 'off'; }
    else if (p.mails) { status = `✅ Suivi actif via Gmail · ${p.mails} mail${p.mails > 1 ? 's' : ''} reçu${p.mails > 1 ? 's' : ''} · dernier ${relTime(p.lastMail)}`; cls = 'on'; }
    else { status = 'Aucun mail reçu pour l\'instant : vérifie que les notifications email sont activées sur la plateforme'; cls = 'wait'; }
    return `<div class="platform ${cls}">
      <div class="p-logo" style="--pc:${l.color}">${esc(l.icon)}</div>
      <div class="p-body">
        <div class="p-name">${esc(p.name)} <span class="muted">· ${p.candidatures} candidature${p.candidatures > 1 ? 's' : ''} dans le CRM</span></div>
        <div class="p-status">${status}</div>
        <div class="p-actions">
          <a class="ghost small-btn" href="${l.applied}" target="_blank" rel="noopener">Mes candidatures ↗</a>
          <a class="ghost small-btn" href="${l.notifs}" target="_blank" rel="noopener">Activer les emails ↗</a>
          ${p.name === 'LinkedIn' ? '<button type="button" class="ghost small-btn" data-li-import>📥 Importer l\'historique</button>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function bindPlatforms() {
  $('#platforms').addEventListener('click', (e) => {
    if (e.target.closest('[data-li-import]')) { const d = $('#li-import'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  $('#li-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const out = $('#li-result');
    out.className = 'muted'; out.textContent = 'Import en cours…';
    try {
      if (file.size > 1.5e6) throw new Error('Fichier trop volumineux (1,5 Mo max)');
      const r = await api('POST', '/api/import/linkedin', { csv: await file.text() });
      items = r.items; render(); renderPlatforms();
      out.className = 'ok';
      out.textContent = `✔ ${r.added} candidature${r.added > 1 ? 's' : ''} ajoutée${r.added > 1 ? 's' : ''}${r.skipped ? ` · ${r.skipped} déjà présente${r.skipped > 1 ? 's' : ''}` : ''}`;
      if (r.added) toast(`📥 LinkedIn : ${r.added} candidature${r.added > 1 ? 's' : ''} importée${r.added > 1 ? 's' : ''}`);
    } catch (err) { out.className = 'err'; out.textContent = '✖ ' + err.message; }
    e.target.value = '';
  });
}

// ---------- Centre de notifications ----------
const NOTIF_KINDS = {
  entretien: { icon: '🎙️', label: 'propose un entretien' },
  reponse:   { icon: '💬', label: 'a répondu' },
  refus:     { icon: '✋', label: 'refus' },
  accuse:    { icon: '📨', label: 'accusé de réception' },
  cloture:   { icon: '🔒', label: 'offre clôturée' },
  relance:   { icon: '↻', label: 'relance envoyée' },
};
let notifs = [], notifFilter = 'all';
const freshIds = new Set(); // non lues à l'ouverture : restent en surbrillance pendant la session

const relTime = (iso) => {
  const d = new Date(iso), days = Math.floor((Date.now() - d) / 864e5);
  if (days < 1) return `aujourd'hui, ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  if (days < 2) return 'hier';
  if (days < 7) return `il y a ${days} jours`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};

async function loadNotifs() {
  try {
    const r = await api('GET', '/api/notifications');
    notifs = r.notifications;
    renderBadge(r.unread);
    if (!$('#notif-panel').hidden) renderNotifs();
  } catch { /* pas bloquant */ }
}

function renderBadge(unread) {
  const b = $('#notif-badge');
  b.hidden = !unread;
  b.textContent = unread > 9 ? '9+' : String(unread);
  $('#btn-notifs').title = unread ? `${unread} notification(s) non lue(s)` : 'Notifications';
}

function notifMatches(n) {
  switch (notifFilter) {
    case 'unread': return !n.read || freshIds.has(n.id);
    case 'positif': return ['entretien', 'reponse'].includes(n.kind);
    case 'refus': return ['refus', 'cloture'].includes(n.kind);
    case 'accuse': return n.kind === 'accuse';
    case 'orphan': return !n.candidatureId && n.kind !== 'relance';
    default: return true;
  }
}

function notifHtml(n) {
  const k = NOTIF_KINDS[n.kind] || NOTIF_KINDS.reponse;
  const who = n.entreprise || n.fromName || n.from;
  const sugg = n.suggestion && STATUTS[n.suggestion];
  const options = items.slice().sort((a, b) => a.entreprise.localeCompare(b.entreprise))
    .map((c) => `<option value="${esc(c.id)}">${esc(c.entreprise)} — ${esc((c.poste || '').slice(0, 50))}</option>`).join('');
  return `<article class="notif kind-${esc(n.kind)} ${!n.read || freshIds.has(n.id) ? 'unread' : ''}" data-id="${esc(n.id)}">
    <div class="notif-icon">${k.icon}</div>
    <div class="notif-body">
      <div class="notif-title"><b>${esc(who)}</b> · ${esc(k.label)}${n.applied ? ` <span class="chip done">✔ ${esc(STATUTS[n.applied]?.label || '')}</span>` : ''}</div>
      <div class="notif-meta">${relTime(n.date)}${n.platform ? ` · <span class="chip">${esc(n.platform)}</span>` : ''}${!n.candidatureId && n.kind !== 'relance' ? ' · <span class="chip todo">non associée</span>' : ''}</div>
      <div class="notif-subject">${esc(n.subject)}</div>
      ${n.snippet ? `<div class="notif-snippet">${esc(n.snippet)}</div>` : ''}
      <div class="notif-actions">
        ${sugg ? `<button class="cta small-btn" data-act="apply">Passer en « ${esc(sugg.label)} »</button>` : ''}
        ${n.candidatureId ? `<button class="ghost small-btn" data-act="open">Voir la fiche</button>` : ''}
        ${!n.candidatureId && n.kind !== 'relance' ? `<button class="ghost small-btn" data-act="create">➕ Créer la candidature</button>
          <select class="link-select" data-act="link" aria-label="Associer à une candidature"><option value="">🔗 Associer à…</option>${options}</select>` : ''}
        ${n.thread ? `<a class="ghost small-btn" href="${gmailUrl(n.thread)}" target="_blank" rel="noopener">Ouvrir dans Gmail ↗</a>` : ''}
        <button class="ghost small-btn icon-only" data-act="dismiss" title="Supprimer la notification">✕</button>
      </div>
    </div>
  </article>`;
}

function renderNotifs() {
  document.querySelectorAll('#notif-filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === notifFilter));
  const list = notifs.filter(notifMatches);
  const unread = notifs.filter((n) => !n.read).length;
  $('#notif-sub').textContent = config.gmail
    ? `${notifs.length} notification${notifs.length > 1 ? 's' : ''} tirée${notifs.length > 1 ? 's' : ''} de ta boîte Gmail (Indeed, LinkedIn, Hellowork et recruteurs compris)${unread ? ` · ${unread} non lue${unread > 1 ? 's' : ''}` : ''}`
    : 'Configure Gmail dans ⚙️ Paramètres pour voir ici les réponses des recruteurs.';
  // Regroupement par période
  const groups = [['Aujourd\'hui', 1], ['Cette semaine', 7], ['Ce mois-ci', 31], ['Plus ancien', Infinity]];
  let html = '', prev = 0;
  for (const [label, maxDays] of groups) {
    // max(0, …) : un mail daté de quelques minutes « dans le futur » (horloge décalée) reste dans « Aujourd'hui ».
    const part = list.filter((n) => { const d = Math.max(0, (Date.now() - new Date(n.date)) / 864e5); return d >= prev && d < maxDays; });
    prev = maxDays;
    if (part.length) html += `<h3 class="notif-group">${label}</h3>` + part.map(notifHtml).join('');
  }
  $('#notif-list').innerHTML = html || `<p class="muted empty">${notifs.length ? 'Rien dans ce filtre.' : 'Aucune notification pour l\'instant. Elles apparaîtront ici à chaque synchronisation avec Gmail.'}</p>`;
}

async function openNotifs() {
  notifs.filter((n) => !n.read).forEach((n) => freshIds.add(n.id));
  $('#notif-panel').hidden = false; $('#notif-backdrop').hidden = false;
  renderNotifs();
  if (notifs.some((n) => !n.read)) {
    const r = await api('POST', '/api/notifications/read', {});
    notifs.forEach((n) => { n.read = true; });
    renderBadge(r.unread);
  }
}
function closeNotifs() { $('#notif-panel').hidden = true; $('#notif-backdrop').hidden = true; }

async function notifAction(id, act, extra = {}) {
  const r = await api('POST', `/api/notifications/${id}/${act}`, extra);
  notifs = r.notifications;
  renderBadge(r.unread);
  if (r.item) {
    const i = items.findIndex((c) => c.id === r.item.id);
    if (i === -1) items.push(r.item); else items[i] = r.item;
    render();
  }
  renderNotifs();
  return r;
}

function bindNotifs() {
  $('#btn-notifs').addEventListener('click', () => ($('#notif-panel').hidden ? openNotifs() : closeNotifs()));
  $('#notif-close').addEventListener('click', closeNotifs);
  $('#notif-backdrop').addEventListener('click', closeNotifs);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#notif-panel').hidden) closeNotifs(); });
  $('#notif-readall').addEventListener('click', async () => {
    freshIds.clear();
    const r = await api('POST', '/api/notifications/read', {});
    notifs.forEach((n) => { n.read = true; });
    renderBadge(r.unread); renderNotifs();
  });
  $('#notif-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    notifFilter = b.dataset.f; renderNotifs();
  });
  $('#notif-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const card = btn.closest('.notif'), n = notifs.find((x) => x.id === card.dataset.id);
    try {
      if (btn.dataset.act === 'open') { closeNotifs(); openForm(items.find((c) => c.id === n.candidatureId)); return; }
      if (btn.dataset.act === 'apply') { const r = await notifAction(n.id, 'apply'); toast(`${r.item.entreprise} → ${STATUTS[r.item.statut].icon} ${STATUTS[r.item.statut].label}`); }
      if (btn.dataset.act === 'create') { const r = await notifAction(n.id, 'create'); toast(`Candidature « ${r.item.entreprise} » créée — vérifie la fiche`); closeNotifs(); openForm(r.item); }
      if (btn.dataset.act === 'dismiss') await notifAction(n.id, 'dismiss');
    } catch (err) { alert(err.message); }
  });
  $('#notif-list').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-act="link"]'); if (!sel || !sel.value) return;
    const card = sel.closest('.notif');
    try {
      const r = await notifAction(card.dataset.id, 'link', { candidatureId: sel.value });
      toast(`Associée à ${r.item.entreprise} — les prochains mails de cet expéditeur seront reconnus`);
    } catch (err) { alert(err.message); }
  });
}

// ---------- Synchronisation avec Gmail ----------
// Au lancement, au retour sur l'onglet (ex. après avoir envoyé un mail dans Gmail) et toutes les 5 minutes.
const SYNC_EVERY = 5 * 60 * 1000, SYNC_MIN_GAP = 30 * 1000;
let lastSyncAt = 0, syncing = false;

const timeAgo = (iso) => {
  if (!iso) return 'jamais';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

function renderSyncLabel(iso) {
  $('#btn-sync').title = config.gmail ? `Synchroniser avec Gmail (dernière synchro : ${timeAgo(iso)})` : 'Configure Gmail dans ⚙️ Paramètres pour synchroniser';
  $('#sync-label').textContent = config.gmail ? (iso ? `Synchro ${timeAgo(iso)}` : 'Synchroniser') : 'Synchroniser';
}

async function syncNow({ manual = false } = {}) {
  if (syncing) return;
  if (!config.gmail) {
    // Sans Gmail : on recharge au moins les données (autre appareil, autre onglet).
    items = await api('GET', '/api/candidatures');
    render();
    if (manual) toast('Configure Gmail dans ⚙️ Paramètres pour détecter tes envois et les réponses');
    return;
  }
  if (!manual && Date.now() - lastSyncAt < SYNC_MIN_GAP) return;
  syncing = true; lastSyncAt = Date.now();
  $('#btn-sync').classList.add('busy');
  try {
    const res = await api('POST', '/api/sync');
    items = res.items;
    render();
    renderSyncLabel(res.lastSync);
    const rel = res.changes.filter((c) => c.type === 'relance'), rep = res.changes.filter((c) => c.type === 'reponse');
    const parts = [];
    if (rel.length) parts.push(`${rel.length} relance${rel.length > 1 ? 's' : ''} envoyée${rel.length > 1 ? 's' : ''} (${rel.map((c) => c.entreprise).slice(0, 3).join(', ')})`);
    if (rep.length) parts.push(`${rep.length} réponse${rep.length > 1 ? 's' : ''} reçue${rep.length > 1 ? 's' : ''} (${rep.map((c) => c.entreprise).slice(0, 3).join(', ')})`);
    await loadNotifs();
    if (res.notifications) parts.push(`🔔 ${res.notifications} nouvelle${res.notifications > 1 ? 's' : ''} notification${res.notifications > 1 ? 's' : ''}`);
    if (parts.length) toast('📬 Gmail : ' + parts.join(' · '));
    else if (manual) toast('Tout est à jour ✔');
  } catch (err) {
    if (manual) alert(err.message);
  } finally {
    syncing = false;
    $('#btn-sync').classList.remove('busy');
  }
}

function bindSync() {
  $('#btn-sync').addEventListener('click', () => syncNow({ manual: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('focus', () => syncNow());
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, SYNC_EVERY);
  setInterval(() => renderSyncLabel(lastSyncAt ? new Date(lastSyncAt).toISOString() : null), 60 * 1000);
}

(async function main() {
  bind();
  bindChart();
  bindRelance();
  bindSettings();
  bindNotifs();
  bindPlatforms();
  me = await api('GET', '/api/auth/me');
  $('#account-email').textContent = me.email;
  $('#avatar').textContent = me.email.charAt(0).toUpperCase();
  [items, config] = await Promise.all([api('GET', '/api/candidatures'), api('GET', '/api/settings')]);
  applyBranding();
  // Raccourcis de l'appli installée (appui long sur l'icône)
  const params = new URLSearchParams(location.search);
  if (params.get('filtre') && KPI_FILTERS[params.get('filtre')]) kpiFilter = params.get('filtre');
  if (params.toString()) history.replaceState(null, '', '/');
  if (params.get('action') === 'new') setTimeout(() => openForm(null), 0);
  render();
  bindSync();
  loadNotifs();
  renderSyncLabel((await api('GET', '/api/sync')).lastSync);
  syncNow();
})();
