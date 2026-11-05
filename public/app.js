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
const relanceJours = () => +config.relanceJours || 21;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
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
    c.derniereRelance && `<span class="chip done">↻ Relance ${fmtDate(c.derniereRelance)}${+c.nbRelances > 1 ? ` (×${c.nbRelances})` : ''}</span>`,
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
      <td><span class="pill"><span class="dot" style="--c:${color(c.statut)}"></span>${esc(STATUTS[c.statut]?.label)}</span></td>
      <td class="act">${c.thread ? `<a class="icon" href="${gmailUrl(c.thread)}" target="_blank" rel="noopener" title="Gmail">✉</a>` : ''}${firstEmail(c).length ? `<button class="icon relance" data-relance="${esc(c.id)}" title="Créer un brouillon de relance dans Gmail">↻</button>` : ''}<button class="icon edit" data-id="${esc(c.id)}" title="Modifier">✎</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">Aucune candidature.</td></tr>`;
}

function render() {
  renderKpis();
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
  const cols = ['dateCandidature', 'entreprise', 'poste', 'type', 'canal', 'email', 'contact', 'statut', 'dateReponse', 'dateEntretien', 'lienOffre', 'adresse', 'notes'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(';'), ...filtered().map((c) => cols.map((k) => cell(k === 'statut' ? STATUTS[c.statut]?.label : c[k])).join(';'))];
  download(`candidatures-${today()}.csv`, '﻿' + lines.join('\n'), 'text/csv');
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
    toast(`Brouillon créé${res.draft?.inThread ? ' dans le fil d\'origine' : ''} ✉️ — ouvre tes brouillons Gmail pour l'envoyer`, DRAFTS_URL);
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
  renderGmailStatus();
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
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      config = await api('PUT', '/api/settings', settingsFormData());
      applyBranding(); render();
      $('#settings-dialog').close();
      toast(config.gmail ? 'Paramètres enregistrés ✔ — relances vers tes brouillons Gmail' : 'Paramètres enregistrés ✔');
    } catch (err) { alert(err.message); }
  });
}

(async function main() {
  bind();
  bindRelance();
  bindSettings();
  [items, config] = await Promise.all([api('GET', '/api/candidatures'), api('GET', '/api/settings')]);
  applyBranding();
  render();
})();
