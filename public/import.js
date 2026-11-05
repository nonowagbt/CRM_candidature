'use strict';
// Import de fichiers CSV venant d'Excel ou de Google Sheets (ou d'un copier-coller de cellules).
// Utilise les fonctions globales de app.js : $, esc, api, items, render, toast, STATUTS.

// ---------- Lecture du fichier ----------
// Excel en français enregistre souvent en Windows-1252 ; Google Sheets et « CSV UTF-8 » en UTF-8.
function decodeBytes(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

// Séparateur le plus fréquent sur la première ligne (hors guillemets) : ; (Excel FR), , (Sheets), tabulation (copier-coller).
function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n ? best : ',';
}

function parseDelimited(text, delim) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => [...r.map((f) => f.trim()), ...Array(width - r.length).fill('')]);
}

// ---------- Correspondance des colonnes ----------
const nrm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const IMPORT_FIELDS = [
  ['', '— Ignorer —'], ['entreprise', 'Entreprise *'], ['poste', 'Poste'], ['type', 'Type de contrat'], ['canal', 'Canal'],
  ['email', 'Email'], ['contact', 'Contact'], ['dateCandidature', 'Date de candidature'], ['statut', 'Statut'],
  ['dateReponse', 'Date de réponse'], ['dateEntretien', "Date d'entretien"], ['lienOffre', "Lien de l'offre"],
  ['adresse', 'Adresse'], ['notes', 'Notes'],
];
// Du plus précis au plus général : « date entretien » doit gagner sur « date ».
const HEADER_RULES = [
  ['dateEntretien', /^(date (d )?entretien|entretien le|date interview|interview date|dateentretien)$/],
  ['dateReponse', /^(date (de )?reponse|repondu le|reponse le|date retour|datereponse)$/],
  ['dateCandidature', /^(date( de)?( la)? candidature|date (d )?envoi|envoye(e)? le|postule le|candidature le|application date|applied( on)?|date postulation|datecandidature|date)$/],
  ['entreprise', /^(entreprise|societe|company|company name|compagnie|employeur|organisation|organisme|structure|nom (de l )?entreprise|boite)$/],
  ['poste', /^(poste|intitule|intitule (du )?poste|titre|job|job title|offre|role|position|emploi|metier|mission)$/],
  ['type', /^(type|contrat|type de contrat|contract|type d offre|type de poste)$/],
  ['canal', /^(canal|source|plateforme|via|site|moyen|support|comment)$/],
  ['email', /^(e ?mail|mail|courriel|adresse (e )?mail|contact email|email contact|email du recruteur)$/],
  ['contact', /^(contact|recruteur|recruteuse|interlocuteur|rh|nom du contact|personne|manager)$/],
  ['statut', /^(statut|etat|status|avancement|resultat|reponse|suivi|etape)$/],
  ['lienOffre', /^(lien|liens|url|link|job link|offer link|lien (de l )?offre|annonce|lien annonce|job url|lienoffre)$/],
  ['adresse', /^(adresse|lieu|ville|localisation|location|localite)$/],
  ['notes', /^(notes?|commentaires?|remarques?|comments?|observations?|infos?)$/],
];
function guessField(header) {
  const h = nrm(header);
  const rule = HEADER_RULES.find(([, re]) => re.test(h));
  return rule ? rule[0] : '';
}

// ---------- Conversion des valeurs ----------
const MONTHS = { janv: 1, jan: 1, janvier: 1, fevr: 2, fev: 2, fevrier: 2, feb: 2, mars: 3, mar: 3, avr: 4, avril: 4, apr: 4, mai: 5, may: 5, juin: 6, jun: 6,
  juil: 7, juillet: 7, jul: 7, aout: 8, aug: 8, sept: 9, sep: 9, septembre: 9, oct: 10, octobre: 10, nov: 11, novembre: 11, dec: 12, decembre: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
function toIsoDate(v) {
  v = String(v || '').trim();
  if (!v) return '';
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let [a, b] = [+m[1], +m[2]];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (b > 12 && a <= 12) [a, b] = [b, a]; // format américain (mois/jour) détecté
    if (a > 31 || b > 12 || !a || !b) return '';
    return `${y}-${pad2(b)}-${pad2(a)}`;
  }
  m = nrm(v).match(/^(\d{1,2}) ([a-z]+) (\d{4})/);
  if (m && MONTHS[m[2]]) return `${m[3]}-${pad2(MONTHS[m[2]])}-${pad2(m[1])}`;
  if (/^\d{5}(\.\d+)?$/.test(v)) { // numéro de série Excel (jours depuis le 30/12/1899)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+v) * 864e5);
    if (d.getUTCFullYear() > 1990 && d.getUTCFullYear() < 2100) return d.toISOString().slice(0, 10);
  }
  return '';
}
function toStatut(v) {
  const t = nrm(v);
  if (!t) return 'postule';
  if (/apres (l )?entretien|post entretien/.test(t) && /refus|non|pas retenu|rejet/.test(t)) return 'refus_entretien';
  if (/refus|rejet|negati|pas retenu|non retenu|^non$|^ko$|decline/.test(t)) return 'refus_direct';
  if (/retenu|accept|embauch|valide|^oui$|^ok$|offre recue|signe|\bpris\b/.test(t)) return 'retenu';
  if (/entretien|interview|rdv|rendez vous|visio|test technique/.test(t)) return 'entretien';
  if (/clotur|ferme|expir|annul|sans suite|plus disponible|pourvu/.test(t)) return 'cloture';
  if (/repon|repondu|en cours|discussion|echange|contact/.test(t)) return 'repondu';
  return 'postule';
}
function toCanal(v, hasEmail) {
  const t = nrm(v);
  if (!t) return hasEmail ? 'Email' : 'Autre plateforme';
  if (/indeed/.test(t)) return 'Indeed';
  if (/linkedin/.test(t)) return 'LinkedIn';
  if (/hellowork|regionsjob/.test(t)) return 'Hellowork';
  if (/jungle|wttj/.test(t)) return 'Welcome to the Jungle';
  if (/sur place|physique|en personne|depot|main propre|salon|forum/.test(t)) return 'En personne';
  if (/telephone|\btel\b|appel/.test(t)) return 'Téléphone';
  if (/mail|courriel/.test(t)) return 'Email';
  if (/site|carriere|career|workday|taleo|successfactors/.test(t)) return 'Site carrière';
  return 'Autre plateforme';
}
function toType(v) {
  const t = nrm(v);
  if (/altern|apprenti/.test(t)) return 'Alternance';
  if (/stage|stagiaire|intern/.test(t)) return 'Stage';
  if (/\bcdd\b/.test(t)) return 'CDD';
  if (/\bcdi\b/.test(t)) return 'CDI';
  if (/freelance|indep/.test(t)) return 'Freelance';
  if (/spontan/.test(t)) return 'Spontanée';
  return '';
}

// ---------- État de l'import ----------
const csvState = { header: [], rows: [], mapping: [], source: '' };

function rowToItem(row) {
  const o = {};
  csvState.mapping.forEach((field, i) => {
    if (!field || !row[i]) return;
    o[field] = o[field] && field === 'notes' ? `${o[field]}\n${row[i]}` : (o[field] || row[i]);
  });
  const hasEmail = /@/.test(o.email || '');
  return {
    entreprise: o.entreprise || '', poste: o.poste || '', email: hasEmail ? o.email : '', contact: o.contact || (hasEmail ? '' : o.email || ''),
    type: toType(o.type) || toType(o.poste) || 'Stage', canal: toCanal(o.canal, hasEmail), statut: toStatut(o.statut),
    dateCandidature: toIsoDate(o.dateCandidature), dateReponse: toIsoDate(o.dateReponse), dateEntretien: toIsoDate(o.dateEntretien),
    lienOffre: /^https?:\/\//i.test(o.lienOffre || '') ? o.lienOffre : '', adresse: o.adresse || '',
    notes: [o.notes, `Importée depuis ${csvState.source}.`].filter(Boolean).join('\n'),
  };
}

function loadTable(text, source) {
  const delim = detectDelimiter(text);
  const table = parseDelimited(text, delim);
  if (table.length < 2) throw new Error('Il faut au moins une ligne de titres et une ligne de données.');
  csvState.header = table[0].map((h, i) => h || `Colonne ${i + 1}`);
  csvState.rows = table.slice(1);
  csvState.source = source;
  // Une même colonne cible n'est attribuée qu'une fois (sauf Notes).
  const used = new Set();
  csvState.mapping = csvState.header.map((h) => {
    const f = guessField(h);
    if (!f || (used.has(f) && f !== 'notes')) return '';
    used.add(f); return f;
  });
  const sep = { ';': 'point-virgule', ',': 'virgule', '\t': 'tabulation' }[delim];
  $('#csv-info').innerHTML = `<b>${esc(source)}</b> · ${csvState.rows.length} ligne${csvState.rows.length > 1 ? 's' : ''} · ${csvState.header.length} colonnes · séparateur : ${sep}`;
  $('#csv-step1').hidden = true; $('#csv-step2').hidden = false; $('#csv-back').hidden = false;
  renderMapping();
}

function renderMapping() {
  $('#csv-map').innerHTML = '<tbody>' + csvState.header.map((h, i) => {
    const samples = csvState.rows.map((r) => r[i]).filter(Boolean).slice(0, 3).join(' · ');
    return `<tr class="${csvState.mapping[i] ? '' : 'ignored'}"><td class="col-name">${esc(h)}</td>
      <td><select data-col="${i}" aria-label="Champ pour la colonne ${esc(h)}">${IMPORT_FIELDS.map(([k, l]) => `<option value="${k}" ${k === csvState.mapping[i] ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
      <td class="samples" title="${esc(samples)}">${samples ? esc(samples) : '<i>vide</i>'}</td></tr>`;
  }).join('') + '</tbody>';
  renderPreview();
}

let previewTimer = null;
function renderPreview() {
  const list = csvState.rows.map(rowToItem);
  const cols = [['entreprise', 'Entreprise'], ['poste', 'Poste'], ['dateCandidature', 'Date'], ['statut', 'Statut'], ['canal', 'Canal'], ['type', 'Type']];
  $('#csv-preview').innerHTML = `<thead><tr>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>` +
    list.slice(0, 8).map((it) => `<tr>${cols.map(([k]) => {
      const v = k === 'statut' ? STATUTS[it.statut].label : k === 'dateCandidature' ? (it[k] ? new Date(it[k] + 'T00:00:00').toLocaleDateString('fr-FR') : '') : it[k];
      return `<td class="${k === 'entreprise' && !it.entreprise ? 'bad' : ''}">${esc(v || (k === 'entreprise' ? 'manquante' : '—'))}</td>`;
    }).join('')}</tr>`).join('') + '</tbody>';
  const hasEntreprise = csvState.mapping.includes('entreprise');
  $('#csv-go').disabled = true;
  if (!hasEntreprise) { $('#csv-summary').innerHTML = '<b class="warn">Indique quelle colonne contient l\'entreprise.</b>'; return; }
  $('#csv-summary').textContent = 'Calcul…';
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const r = await api('POST', '/api/import/rows', { rows: list, dryRun: true });
      $('#csv-summary').innerHTML = `<b class="ok">${r.added} candidature${r.added > 1 ? 's' : ''} à ajouter</b>` +
        (r.skipped ? ` · <b class="warn">${r.skipped} déjà dans le CRM</b> (ignorée${r.skipped > 1 ? 's' : ''})` : '') +
        (r.invalid ? ` · ${r.invalid} ligne${r.invalid > 1 ? 's' : ''} sans entreprise (ignorée${r.invalid > 1 ? 's' : ''})` : '');
      $('#csv-go').textContent = r.added ? `Importer ${r.added} candidature${r.added > 1 ? 's' : ''}` : 'Rien à importer';
      $('#csv-go').disabled = !r.added;
    } catch (err) { $('#csv-summary').textContent = err.message; }
  }, 150);
}

function resetCsv() {
  Object.assign(csvState, { header: [], rows: [], mapping: [], source: '' });
  $('#csv-step1').hidden = false; $('#csv-step2').hidden = true; $('#csv-back').hidden = true;
  $('#csv-go').disabled = true; $('#csv-go').textContent = 'Importer';
  $('#csv-file').value = ''; $('#csv-paste').value = '';
}

async function readCsvFile(file) {
  if (/\.xlsx?$/i.test(file.name)) throw new Error('Fichier Excel (.xlsx) : dans Excel, fais « Fichier → Enregistrer sous → CSV UTF-8 », puis importe ce fichier.');
  if (file.size > 3e6) throw new Error('Fichier trop volumineux (3 Mo max).');
  loadTable(decodeBytes(await file.arrayBuffer()), file.name);
}

function downloadTemplate() {
  const head = ['Entreprise', 'Poste', 'Type', 'Canal', 'Email', 'Contact', 'Date de candidature', 'Statut', 'Date de réponse', "Date d'entretien", "Lien de l'offre", 'Adresse', 'Notes'];
  const ex = ['ACME', 'Stage Développeur Full Stack', 'Stage', 'Email', 'rh@acme.fr', 'Mme Dupont', '05/11/2026', 'En attente', '', '', 'https://acme.fr/offre', '', 'Envoyé avec CV + lettre'];
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const blob = new Blob(['﻿' + [head, ex].map((r) => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'modele-candidatures.csv'; a.click();
  URL.revokeObjectURL(a.href);
}

function bindCsvImport() {
  const dlg = $('#csv-dialog');
  const fail = (err) => alert(err.message);
  $('#btn-import-csv').addEventListener('click', () => { $('#menu-pop').hidden = true; resetCsv(); dlg.showModal(); });
  ['#csv-close', '#csv-cancel'].forEach((s) => $(s).addEventListener('click', () => dlg.close()));
  $('#csv-back').addEventListener('click', resetCsv);
  $('#csv-template').addEventListener('click', (e) => { e.preventDefault(); downloadTemplate(); });
  $('#csv-file').addEventListener('change', (e) => { if (e.target.files[0]) readCsvFile(e.target.files[0]).catch(fail); });
  $('#csv-paste-go').addEventListener('click', () => {
    try { loadTable($('#csv-paste').value, 'un copier-coller'); } catch (err) { fail(err); }
  });
  const drop = $('#csv-drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readCsvFile(f).catch(fail); });
  $('#csv-map').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-col]'); if (!sel) return;
    const i = +sel.dataset.col, f = sel.value;
    // Une seule colonne par champ (sauf Notes) : l'ancienne est libérée.
    if (f && f !== 'notes') csvState.mapping = csvState.mapping.map((x, j) => (x === f && j !== i ? '' : x));
    csvState.mapping[i] = f;
    renderMapping();
  });
  $('#csv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#csv-go'); btn.disabled = true;
    try {
      const r = await api('POST', '/api/import/rows', { rows: csvState.rows.map(rowToItem) });
      items = r.items; render();
      dlg.close();
      toast(`📊 ${r.added} candidature${r.added > 1 ? 's' : ''} importée${r.added > 1 ? 's' : ''}${r.skipped ? ` · ${r.skipped} doublon${r.skipped > 1 ? 's' : ''} ignoré${r.skipped > 1 ? 's' : ''}` : ''}`);
    } catch (err) { fail(err); btn.disabled = false; }
  });
}
bindCsvImport();
