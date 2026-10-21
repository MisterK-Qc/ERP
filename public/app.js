'use strict';

// ---------- Utilities ----------

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Raw(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v === false || v == null ? '' : esc(v));
// Tagged template that HTML-escapes every interpolated value unless wrapped in raw() or html``.
const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

const STATUS = {
  draft: 'Archivé (sans workflow)',
  in_progress: 'En cours',
  approved: 'Approuvé',
  rejected: 'Rejeté',
};
const ACTIONS = {
  uploaded: 'a déposé le document',
  edited: 'a modifié les métadonnées',
  new_version: 'a déposé une nouvelle version',
  workflow_started: 'a démarré le workflow',
  approved_step: "a validé l'étape",
  rejected: "a rejeté le document à l'étape",
  commented: 'a commenté',
  completed: 'Workflow terminé',
};
const LEVELS = { read: 'Lecture', write: 'Lecture et écriture' };

const formatDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const formatSize = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
const badge = (status) => html`<span class="badge ${status}">${STATUS[status] ?? status}</span>`;
const overdueBadge = (on) => (on ? html` <span class="badge overdue">En retard</span>` : '');
const tags = (t) => (t ? t.split(',').map((x) => html`<span class="tag">${x.trim()}</span>`) : '');
// Search snippets arrive with \u0002…\u0003 around matches.
const snippet = (s) => raw(esc(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>'));
const option = (value, label, current) =>
  html`<option value="${value}" ${String(current ?? '') === String(value) ? raw('selected') : ''}>${label}</option>`;
const folderOptions = (folders, current, { rootLabel = 'Non classé', onlyWritable = false } = {}) => [
  rootLabel ? option('', rootLabel, current) : '',
  ...folders.filter((f) => !onlyWritable || f.level === 'write').map((f) => option(f.id, f.path, current)),
];

// Groups workflow steps into stages: steps that share a position run in parallel.
function stages(steps) {
  const byPosition = new Map();
  for (const s of steps) {
    if (!byPosition.has(s.position)) byPosition.set(s.position, []);
    byPosition.get(s.position).push(s);
  }
  return [...byPosition.entries()].map(([position, list], i) => ({ position, number: i + 1, steps: list }));
}

let me = null;

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/api/login') {
    me = null;
    renderLogin();
    throw new Error('Session expirée');
  }
  if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// Wraps an async event handler so failures surface as a toast.
const guard = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (err) {
    toast(err.message, true);
  }
};

function render(content) {
  view.innerHTML = fmt(content);
}

function currentStepCell(d) {
  if (d.status !== 'in_progress') return html`<span class="sub">${d.workflow_name ?? '—'}</span>`;
  const pending = d.current_steps.filter((s) => s.status === 'pending');
  return html`<span class="sub">Étape ${d.stage_index}/${d.stage_total}</span>${overdueBadge(d.overdue)}
    ${pending.map((s) => html`<div>${s.name} <span class="sub">· ${s.assignee_label}</span></div>`)}`;
}

function documentTable(docs, { emptyText = 'Aucun document.' } = {}) {
  if (!docs.length) return html`<div class="empty">${emptyText}</div>`;
  return html`
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Document</th><th>Statut</th><th>Étape en cours</th><th>Déposé par</th><th>Mis à jour</th>
      </tr></thead>
      <tbody>${docs.map(
        (d) => html`<tr>
          <td>
            <a href="#/doc/${d.id}">${d.title}</a>
            <div class="sub">${d.folder_path ? html`📁 ${d.folder_path} · ` : ''}${d.original_name} · ${formatSize(d.size)}${d.current_version > 1 ? html` · v${d.current_version}` : ''}</div>
            ${d.snippet ? html`<div class="snippet">${snippet(d.snippet)}</div>` : ''}
            <div>${tags(d.tags)}</div>
          </td>
          <td>${badge(d.status)}</td>
          <td>${currentStepCell(d)}</td>
          <td>${d.uploaded_by_name}</td>
          <td class="sub">${formatDate(d.updated_at)}</td>
        </tr>`
      )}</tbody>
    </table></div>`;
}

// ---------- Views ----------

function renderLogin() {
  $('#topbar').hidden = true;
  render(html`
    <div class="login-wrap card">
      <h1>ArchiDoc</h1>
      <form id="login-form">
        <div class="field"><label for="username">Nom d'utilisateur</label><input id="username" name="username" autocomplete="username" required autofocus></div>
        <div class="field"><label for="password">Mot de passe</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <div class="error" id="login-error"></div>
        <button type="submit" style="width:100%;justify-content:center">Se connecter</button>
      </form>
      <p class="hint">Comptes de démonstration : admin/admin, alice/alice, bob/bob</p>
    </div>`);
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      await boot();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
}

async function renderDashboard() {
  const { assigned, mine, counts } = await api('/api/dashboard');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const late = assigned.filter((d) => d.overdue).length;
  render(html`
    <h1>Bonjour ${me.display_name}</h1>
    <div class="stats">
      <div class="stat"><div class="value">${assigned.length}</div><div class="label">À traiter par moi</div></div>
      <div class="stat ${late ? 'alert' : ''}"><div class="value">${late}</div><div class="label">En retard</div></div>
      <div class="stat"><div class="value">${counts.in_progress ?? 0}</div><div class="label">En cours (visibles)</div></div>
      <div class="stat"><div class="value">${counts.approved ?? 0}</div><div class="label">Approuvés</div></div>
      <div class="stat"><div class="value">${total}</div><div class="label">Documents accessibles</div></div>
    </div>
    <h2>Documents qui me sont assignés</h2>
    ${documentTable(assigned, { emptyText: 'Rien à traiter pour le moment.' })}
    <h2>Mes derniers dépôts</h2>
    ${documentTable(mine, { emptyText: "Vous n'avez encore déposé aucun document." })}`);
}

async function renderSearch(params) {
  const [workflows, users, folders] = await Promise.all([api('/api/workflows'), api('/api/users'), api('/api/folders')]);
  const results = await api(`/api/documents?${new URLSearchParams(params)}`);
  render(html`
    <h1>Recherche</h1>
    <form id="search-form" class="card">
      <div class="field"><label for="q">Mots-clés</label><input id="q" name="q" value="${params.q ?? ''}" placeholder="Titre, description, étiquettes, nom ou contenu du fichier…" autofocus>
        <div class="hint">Recherche aussi dans le texte des PDF, Word (.docx) et fichiers texte. Accents ignorés, début de mot accepté.</div></div>
      <div class="row">
        <div class="field"><label>Dossier</label><select name="folder_id">${option('', 'Tous', params.folder_id)}${option('none', 'Non classé', params.folder_id)}${folderOptions(folders, params.folder_id, { rootLabel: null })}</select></div>
        <div class="field"><label>Statut</label><select name="status">${option('', 'Tous', params.status)}${Object.entries(STATUS).map(([k, v]) => option(k, v, params.status))}</select></div>
        <div class="field"><label>Workflow</label><select name="workflow_id">${option('', 'Tous', params.workflow_id)}${workflows.map((w) => option(w.id, w.name, params.workflow_id))}</select></div>
      </div>
      <div class="row">
        <div class="field"><label>Déposé par</label><select name="uploaded_by">${option('', 'Tous', params.uploaded_by)}${users.map((u) => option(u.id, u.display_name, params.uploaded_by))}</select></div>
        <div class="field"><label>Du</label><input type="date" name="from" value="${params.from ?? ''}"></div>
        <div class="field"><label>Au</label><input type="date" name="to" value="${params.to ?? ''}"></div>
      </div>
      <div class="actions"><button type="submit">Rechercher</button><a class="button ghost" href="#/search">Réinitialiser</a></div>
    </form>
    <p class="hint">${results.length} résultat${results.length > 1 ? 's' : ''}${results.length === 200 ? ' (limité à 200)' : ''}</p>
    ${documentTable(results, { emptyText: 'Aucun document ne correspond à ces critères.' })}`);
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(e.target)) if (v) p.set(k, v);
    location.hash = `#/search?${p}`;
  });
}

function stagesSummary(steps) {
  return stages(steps).map(
    (st, i) => html`${i ? ' → ' : ''}${st.steps.map((s, j) => html`${j ? ' + ' : ''}${s.name} (${s.assignee_label})`)}`
  );
}

async function renderUpload() {
  const [workflows, folders] = await Promise.all([api('/api/workflows'), api('/api/folders')]);
  render(html`
    <h1>Déposer un document</h1>
    <form id="upload-form" class="card">
      <div class="field"><label for="file">Fichier (50 Mo max)</label><input id="file" type="file" name="file" required></div>
      <div class="field"><label for="title">Titre</label><input id="title" name="title" placeholder="Par défaut : nom du fichier"></div>
      <div class="field"><label for="description">Description</label><textarea id="description" name="description"></textarea></div>
      <div class="row">
        <div class="field"><label for="tags">Étiquettes (séparées par des virgules)</label><input id="tags" name="tags" placeholder="facture, 2026, fournisseur-x"></div>
        <div class="field"><label for="folder_id">Dossier</label><select id="folder_id" name="folder_id">${folderOptions(folders, '', { onlyWritable: true })}</select></div>
      </div>
      <div class="field"><label for="workflow_id">Workflow</label>
        <select id="workflow_id" name="workflow_id">
          <option value="">Aucun — archiver seulement</option>
          ${workflows.map((w) => html`<option value="${w.id}">${w.name}</option>`)}
        </select>
        <div class="hint" id="wf-preview"></div>
      </div>
      <button type="submit">Déposer</button>
    </form>`);
  $('#workflow_id').addEventListener('change', () => {
    const wf = workflows.find((w) => String(w.id) === $('#workflow_id').value);
    $('#wf-preview').innerHTML = wf ? fmt(html`Étapes : ${stagesSummary(wf.steps)}`) : '';
  });
  $('#upload-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', e.target);
    button.disabled = true;
    try {
      const doc = await api('/api/documents', { method: 'POST', form: new FormData(e.target) });
      toast('Document déposé');
      location.hash = `#/doc/${doc.id}`;
    } finally {
      button.disabled = false;
    }
  }));
}

function stepStatusLine(s) {
  if (s.status === 'approved') return html`<div class="who ok">✓ Approuvé${s.acted_by_name ? html` par ${s.acted_by_name}` : ''}${s.acted_at ? html` le ${formatDate(s.acted_at)}` : ''}</div>`;
  if (s.status === 'rejected') return html`<div class="who ko">✗ Rejeté par ${s.acted_by_name} le ${formatDate(s.acted_at)}</div>`;
  if (s.status === 'pending') {
    const late = s.due_at && new Date(s.due_at.replace(' ', 'T') + 'Z') < new Date();
    return html`<div class="who">En attente${s.due_at ? html` · échéance ${formatDate(s.due_at)}` : ''}${overdueBadge(late)}</div>`;
  }
  if (s.status === 'skipped') return html`<div class="who">Non traité</div>`;
  return s.due_days ? html`<div class="who">Délai : ${s.due_days} j</div>` : '';
}

function workflowTimeline(doc) {
  return html`<ol class="steps">${stages(doc.workflow.steps).map((st) => {
    const statuses = st.steps.map((s) => s.status);
    const cls = statuses.includes('rejected')
      ? 'blocked'
      : statuses.every((s) => s === 'approved')
        ? 'done'
        : doc.status === 'in_progress' && st.position === doc.current_step
          ? 'current'
          : '';
    return html`<li class="${cls}">
      <span class="num">${st.number}</span>
      <div class="stage">
        ${st.steps.length > 1 ? html`<div class="parallel-label">En parallèle — toutes requises</div>` : ''}
        ${st.steps.map((s) => html`<div class="stage-step">${s.name}<div class="who">${s.assignee_label}</div>${stepStatusLine(s)}</div>`)}
      </div>
    </li>`;
  })}</ol>`;
}

async function renderDocument(id) {
  let doc;
  try {
    doc = await api(`/api/documents/${id}`);
  } catch (err) {
    return render(html`<div class="empty">${err.message} — il est possible que vous n'y ayez plus accès. <a href="#/dashboard">Retour au tableau de bord</a></div>`);
  }
  const [workflows, folders] = await Promise.all([
    doc.can_start ? api('/api/workflows') : [],
    doc.can_edit ? api('/api/folders') : [],
  ]);
  const fileUrl = `/api/documents/${doc.id}/file`;
  const previewable = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/.test(doc.mime_type);

  render(html`
    <p><a href="javascript:history.back()">← Retour</a></p>
    <h1>${doc.title} ${badge(doc.status)}${overdueBadge(doc.overdue)}</h1>
    ${doc.folder_path ? html`<p class="hint" style="margin-top:-12px">📁 ${doc.folder_path}</p>` : ''}
    <div class="grid-2">
      <div>
        ${doc.can_act ? html`
          <div class="card" style="border-color:var(--primary)">
            <h3>Votre action est requise — ${doc.my_steps.length > 1 ? 'étapes' : 'étape'} « ${doc.my_steps.join(' », « ')} »</h3>
            <div class="field"><textarea id="action-comment" placeholder="Commentaire (obligatoire en cas de rejet)"></textarea></div>
            <div class="actions">
              <button class="success" data-action="approve">Approuver</button>
              <button class="danger" data-action="reject">Rejeter</button>
            </div>
          </div>` : ''}
        <div class="card">
          <h3>Aperçu${doc.current_version > 1 ? html` — version ${doc.current_version}` : ''}</h3>
          ${previewable
            ? doc.mime_type.startsWith('image/')
              ? html`<img class="preview" src="${fileUrl}?inline=1" alt="${doc.title}">`
              : html`<iframe class="preview" src="${fileUrl}?inline=1" title="Aperçu"></iframe>`
            : html`<div class="empty">Aperçu non disponible pour ce type de fichier.</div>`}
          <div class="actions" style="margin-top:12px"><a class="button ghost" href="${fileUrl}">Télécharger</a></div>
        </div>
        <div class="card">
          <h3>Versions</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Version</th><th>Fichier</th><th>Déposée par</th><th>Date</th><th></th></tr></thead>
            <tbody>${doc.versions.map((v) => html`<tr>
              <td>v${v.version}${v.version === doc.current_version ? html` <span class="badge approved">actuelle</span>` : ''}</td>
              <td>${v.original_name}<div class="sub">${formatSize(v.size)}${v.comment ? html` · ${v.comment}` : ''}</div></td>
              <td>${v.uploaded_by_name ?? '—'}</td>
              <td class="sub">${formatDate(v.created_at)}</td>
              <td><a href="${fileUrl}?version=${v.version}">Télécharger</a></td>
            </tr>`)}</tbody>
          </table></div>
          ${doc.can_edit ? html`
            <form id="version-form" style="margin-top:12px">
              <div class="row">
                <div class="field"><label>Nouvelle version</label><input type="file" name="file" required></div>
                <div class="field"><label>Note de version</label><input name="comment" placeholder="Ce qui a changé"></div>
              </div>
              <button class="small" type="submit">Déposer la version ${doc.current_version + 1}</button>
            </form>` : ''}
        </div>
        <div class="card">
          <h3>Historique</h3>
          <ul class="history">${doc.history.map((h) => html`<li>
            <div><strong>${h.user_name ?? ''}</strong> ${ACTIONS[h.action] ?? h.action}${h.step_name ? html` « ${h.step_name} »` : ''}</div>
            <div class="when">${formatDate(h.created_at)}</div>
            ${h.comment ? html`<div class="comment">${h.comment}</div>` : ''}
          </li>`)}</ul>
          <form id="comment-form" style="margin-top:12px">
            <div class="field"><textarea name="comment" placeholder="Ajouter un commentaire…" required></textarea></div>
            <button class="ghost small" type="submit">Commenter</button>
          </form>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Informations</h3>
          <dl class="meta">
            <dt>Dossier</dt><dd>${doc.folder_path || 'Non classé'}</dd>
            <dt>Fichier</dt><dd>${doc.original_name}</dd>
            <dt>Taille</dt><dd>${formatSize(doc.size)}</dd>
            <dt>Type</dt><dd>${doc.mime_type}</dd>
            <dt>Version</dt><dd>${doc.current_version}</dd>
            <dt>Déposé par</dt><dd>${doc.uploaded_by_name}</dd>
            <dt>Déposé le</dt><dd>${formatDate(doc.created_at)}</dd>
            <dt>Étiquettes</dt><dd>${tags(doc.tags) || '—'}</dd>
          </dl>
          ${doc.description ? html`<p style="white-space:pre-wrap">${doc.description}</p>` : ''}
          <div class="actions" style="margin-top:12px">
            ${doc.can_edit ? html`<button class="ghost small" id="edit-meta">Modifier / déplacer</button>` : ''}
            ${doc.can_delete ? html`<button class="danger small" id="delete-doc">Supprimer</button>` : ''}
          </div>
          ${doc.can_edit ? html`
            <form id="meta-form" hidden style="margin-top:12px">
              <div class="field"><label>Titre</label><input name="title" value="${doc.title}" required></div>
              <div class="field"><label>Description</label><textarea name="description">${doc.description}</textarea></div>
              <div class="field"><label>Étiquettes</label><input name="tags" value="${doc.tags}"></div>
              <div class="field"><label>Dossier</label><select name="folder_id">${folderOptions(folders, doc.folder_id ?? '', { onlyWritable: true })}</select></div>
              <button class="small" type="submit">Enregistrer</button>
            </form>` : ''}
        </div>
        <div class="card">
          <h3>Workflow${doc.workflow ? html` : ${doc.workflow.name}` : ''}</h3>
          ${doc.workflow ? workflowTimeline(doc) : html`<p class="hint">Aucun workflow associé.</p>`}
          ${doc.can_start && workflows.length ? html`
            <form id="start-form" style="margin-top:12px">
              <div class="field"><label>${doc.status === 'draft' ? 'Démarrer un workflow' : 'Relancer un workflow'}</label>
                <select name="workflow_id">${workflows.map((w) => option(w.id, w.name, doc.workflow_id))}</select>
              </div>
              <button class="small" type="submit">Démarrer</button>
            </form>` : ''}
        </div>
      </div>
    </div>`);

  const reload = () => renderDocument(id);
  $$('[data-action]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api(`/api/documents/${doc.id}/actions`, { method: 'POST', body: { action: b.dataset.action, comment: $('#action-comment').value } });
    toast(b.dataset.action === 'approve' ? 'Étape validée' : 'Document rejeté');
    await reload();
  })));
  $('#comment-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api(`/api/documents/${doc.id}/actions`, { method: 'POST', body: { action: 'comment', comment: new FormData(e.target).get('comment') } });
    await reload();
  }));
  $('#version-form')?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', e.target);
    button.disabled = true;
    try {
      await api(`/api/documents/${doc.id}/versions`, { method: 'POST', form: new FormData(e.target) });
      toast('Nouvelle version déposée');
      await reload();
    } finally {
      button.disabled = false;
    }
  }));
  $('#start-form')?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api(`/api/documents/${doc.id}/start`, { method: 'POST', body: { workflow_id: new FormData(e.target).get('workflow_id') } });
    toast('Workflow démarré');
    await reload();
  }));
  $('#edit-meta')?.addEventListener('click', () => ($('#meta-form').hidden = !$('#meta-form').hidden));
  $('#meta-form')?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api(`/api/documents/${doc.id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) });
    toast('Modifications enregistrées');
    await reload();
  }));
  $('#delete-doc')?.addEventListener('click', guard(async () => {
    if (!confirm('Supprimer définitivement ce document et toutes ses versions ?')) return;
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    toast('Document supprimé');
    location.hash = '#/search';
  }));
}

async function renderProfile() {
  const profile = await api('/api/me');
  render(html`
    <h1>Mon profil</h1>
    <form id="profile-form" class="card">
      <div class="row">
        <div class="field"><label>Nom affiché</label><input name="display_name" value="${profile.display_name}" required></div>
        <div class="field"><label>Adresse courriel</label><input type="email" name="email" value="${profile.email}" placeholder="prenom.nom@exemple.com"></div>
      </div>
      <div class="checklist field"><label><input type="checkbox" name="notify_email" ${profile.notify_email ? raw('checked') : ''}> Recevoir les notifications par courriel (étapes assignées, relances, approbations et rejets de mes documents)</label></div>
      <button type="submit">Enregistrer</button>
    </form>
    <h2>Mot de passe</h2>
    <form id="password-form" class="card">
      <div class="row">
        <div class="field"><label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password" required></div>
        <div class="field"><label>Nouveau mot de passe</label><input type="password" name="next" autocomplete="new-password" minlength="4" required></div>
      </div>
      <button type="submit">Changer le mot de passe</button>
    </form>`);
  $('#profile-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/me', { method: 'PATCH', body: { display_name: f.get('display_name'), email: f.get('email'), notify_email: f.has('notify_email') } });
    me.display_name = f.get('display_name');
    $('#whoami').textContent = me.display_name;
    toast('Profil enregistré');
  }));
  $('#password-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/api/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Mot de passe modifié');
  }));
}

// ---------- Administration ----------

async function renderAdmin(params) {
  if (!me.is_admin) return render(html`<div class="empty">Accès réservé aux administrateurs.</div>`);
  const tab = params.tab ?? 'workflows';
  const [users, groups, workflows, folders] = await Promise.all([
    api('/api/users'), api('/api/groups'), api('/api/workflows'), api('/api/folders'),
  ]);
  const tabLink = (key, label) => html`<a class="button ${tab === key ? '' : 'ghost'} small" href="#/admin?tab=${key}">${label}</a>`;

  let body;
  if (tab === 'users') body = adminUsers(users);
  else if (tab === 'groups') body = adminGroups(groups, users);
  else if (tab === 'folders') body = adminFolders(folders, params.edit);
  else body = adminWorkflows(workflows, params.edit);

  render(html`
    <h1>Administration</h1>
    <div class="actions" style="margin-bottom:16px">${tabLink('workflows', 'Workflows')}${tabLink('folders', 'Dossiers et droits')}${tabLink('groups', 'Groupes')}${tabLink('users', 'Utilisateurs')}</div>
    ${body}`);

  const refresh = () => renderAdmin(params);
  if (tab === 'users') bindUsers(refresh);
  else if (tab === 'groups') bindGroups(refresh);
  else if (tab === 'folders') bindFolders(folders, users, groups, params.edit, refresh);
  else bindWorkflows(workflows, users, groups, params.edit);
}

function adminUsers(users) {
  return html`
    <div class="table-wrap"><table>
      <thead><tr><th>Nom</th><th>Identifiant</th><th>Courriel</th><th>Rôle</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr>
        <td>${u.display_name}</td><td>${u.username}</td>
        <td>${u.email || html`<span class="sub">—</span>`}${u.email && !u.notify_email ? html`<div class="sub">notifications désactivées</div>` : ''}</td>
        <td>${u.is_admin ? 'Administrateur' : 'Utilisateur'}</td>
        <td class="actions">
          <button class="ghost small" data-email="${u.id}" data-current="${u.email}">Courriel</button>
          <button class="ghost small" data-reset="${u.id}">Mot de passe</button>
          ${u.id !== me.id ? html`
            <button class="ghost small" data-admin="${u.id}" data-value="${u.is_admin ? '0' : '1'}">${u.is_admin ? 'Retirer admin' : 'Rendre admin'}</button>
            <button class="danger small" data-delete-user="${u.id}">Supprimer</button>` : ''}
        </td>
      </tr>`)}</tbody>
    </table></div>
    <h2>Nouvel utilisateur</h2>
    <form id="user-form" class="card">
      <div class="row">
        <div class="field"><label>Nom affiché</label><input name="display_name" required></div>
        <div class="field"><label>Identifiant</label><input name="username" required></div>
        <div class="field"><label>Courriel</label><input name="email" type="email"></div>
        <div class="field"><label>Mot de passe</label><input name="password" type="password" required></div>
      </div>
      <div class="checklist field"><label><input type="checkbox" name="is_admin"> Administrateur</label></div>
      <button type="submit">Créer</button>
    </form>`;
}

function bindUsers(refresh) {
  $('#user-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/users', {
      method: 'POST',
      body: { display_name: f.get('display_name'), username: f.get('username'), email: f.get('email'), password: f.get('password'), is_admin: f.has('is_admin') },
    });
    toast('Utilisateur créé');
    await refresh();
  }));
  $$('[data-email]').forEach((b) => b.addEventListener('click', guard(async () => {
    const email = prompt('Adresse courriel :', b.dataset.current);
    if (email === null) return;
    await api(`/api/users/${b.dataset.email}`, { method: 'PATCH', body: { email } });
    await refresh();
  })));
  $$('[data-reset]').forEach((b) => b.addEventListener('click', guard(async () => {
    const password = prompt('Nouveau mot de passe :');
    if (!password) return;
    await api(`/api/users/${b.dataset.reset}`, { method: 'PATCH', body: { password } });
    toast('Mot de passe modifié');
  })));
  $$('[data-admin]').forEach((b) => b.addEventListener('click', guard(async () => {
    await api(`/api/users/${b.dataset.admin}`, { method: 'PATCH', body: { is_admin: b.dataset.value === '1' } });
    await refresh();
  })));
  $$('[data-delete-user]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Supprimer cet utilisateur ?')) return;
    await api(`/api/users/${b.dataset.deleteUser}`, { method: 'DELETE' });
    await refresh();
  })));
}

function adminGroups(groups, users) {
  return html`
    ${groups.map((g) => html`
      <form class="card group-form" data-group="${g.id}">
        <div class="actions" style="justify-content:space-between"><h3>${g.name}</h3><button type="button" class="danger small" data-delete-group="${g.id}">Supprimer</button></div>
        <div class="checklist field">${users.map((u) => html`<label><input type="checkbox" name="user_ids" value="${u.id}" ${g.members.some((m) => m.id === u.id) ? raw('checked') : ''}> ${u.display_name}</label>`)}</div>
        <button type="submit" class="small">Enregistrer les membres</button>
      </form>`)}
    <h2>Nouveau groupe</h2>
    <form id="group-form" class="card actions">
      <input name="name" placeholder="Nom du groupe" required style="flex:1">
      <button type="submit">Créer</button>
    </form>`;
}

function bindGroups(refresh) {
  $('#group-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/api/groups', { method: 'POST', body: { name: new FormData(e.target).get('name') } });
    toast('Groupe créé');
    await refresh();
  }));
  $$('.group-form').forEach((f) => f.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api(`/api/groups/${f.dataset.group}/members`, { method: 'PUT', body: { user_ids: new FormData(f).getAll('user_ids') } });
    toast('Membres enregistrés');
    await refresh();
  })));
  $$('[data-delete-group]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Supprimer ce groupe ?')) return;
    await api(`/api/groups/${b.dataset.deleteGroup}`, { method: 'DELETE' });
    await refresh();
  })));
}

function permissionsSummary(folder, folders) {
  if (folder.permissions.length) {
    return folder.permissions.map((p) => html`<span class="tag">${p.label} — ${LEVELS[p.level]}</span>`);
  }
  for (let parent = folders.find((f) => f.id === folder.parent_id); parent; parent = folders.find((f) => f.id === parent.parent_id)) {
    if (parent.permissions.length) return html`<span class="sub">Hérite de « ${parent.path} »</span>`;
  }
  return html`<span class="sub">Ouvert à tous les utilisateurs</span>`;
}

function adminFolders(folders, editId) {
  const editing = folders.find((f) => String(f.id) === editId);
  if (editing) {
    return html`
      <form id="folder-form" class="card">
        <h3>Dossier « ${editing.path} »</h3>
        <div class="row">
          <div class="field"><label>Nom</label><input name="name" value="${editing.name}" required></div>
          <div class="field"><label>Dossier parent</label><select name="parent_id">${folderOptions(
            folders.filter((f) => f.id !== editing.id && !f.path.startsWith(editing.path + ' / ')),
            editing.parent_id ?? '',
            { rootLabel: '(racine)' }
          )}</select></div>
        </div>
        <label>Droits d'accès</label>
        <p class="hint">Sans aucune ligne, le dossier hérite des droits de son parent (ou est ouvert à tous à la racine). Dès qu'une ligne existe, seuls les utilisateurs et groupes listés (et les administrateurs) y ont accès.</p>
        <div id="perms"></div>
        <div class="actions" style="margin:8px 0 16px"><button type="button" class="ghost small" id="add-perm">+ Ajouter un droit</button></div>
        <div class="actions"><button type="submit">Enregistrer</button><a class="button ghost" href="#/admin?tab=folders">Annuler</a></div>
      </form>`;
  }
  return html`
    ${folders.length ? html`
      <div class="table-wrap"><table>
        <thead><tr><th>Dossier</th><th>Documents</th><th>Droits</th><th></th></tr></thead>
        <tbody>${folders.map((f) => html`<tr>
          <td>📁 ${f.path}</td>
          <td>${f.document_count}</td>
          <td>${permissionsSummary(f, folders)}</td>
          <td class="actions">
            <a class="button ghost small" href="#/admin?tab=folders&edit=${f.id}">Modifier</a>
            <button class="danger small" data-delete-folder="${f.id}">Supprimer</button>
          </td>
        </tr>`)}</tbody>
      </table></div>` : html`<div class="empty">Aucun dossier.</div>`}
    <h2>Nouveau dossier</h2>
    <form id="new-folder-form" class="card">
      <div class="row">
        <div class="field"><label>Nom</label><input name="name" required></div>
        <div class="field"><label>Dans</label><select name="parent_id">${folderOptions(folders, '', { rootLabel: '(racine)' })}</select></div>
      </div>
      <button type="submit">Créer</button>
    </form>`;
}

function bindFolders(folders, users, groups, editId, refresh) {
  $('#new-folder-form')?.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/api/folders', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Dossier créé');
    await refresh();
  }));
  $$('[data-delete-folder]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Supprimer ce dossier ?')) return;
    await api(`/api/folders/${b.dataset.deleteFolder}`, { method: 'DELETE' });
    await refresh();
  })));
  const form = $('#folder-form');
  if (!form) return;

  const folder = folders.find((f) => String(f.id) === editId);
  const subjectOptions = (type, selected) =>
    (type === 'user' ? users.map((u) => [u.id, u.display_name]) : groups.map((g) => [g.id, g.name])).map(([id, label]) => option(id, label, selected));
  const permsEl = $('#perms');
  function addPerm(p = { subject_type: 'group', subject_id: null, level: 'read' }) {
    const row = document.createElement('div');
    row.className = 'perm-editor';
    row.innerHTML = fmt(html`
      <select data-f="type">${option('user', 'Utilisateur', p.subject_type)}${option('group', 'Groupe', p.subject_type)}</select>
      <select data-f="subject">${subjectOptions(p.subject_type, p.subject_id)}</select>
      <select data-f="level">${Object.entries(LEVELS).map(([k, v]) => option(k, v, p.level))}</select>
      <button type="button" class="ghost small" data-f="remove" title="Retirer">✕</button>`);
    $('[data-f=type]', row).addEventListener('change', (e) => ($('[data-f=subject]', row).innerHTML = fmt(subjectOptions(e.target.value, null))));
    $('[data-f=remove]', row).addEventListener('click', () => row.remove());
    permsEl.append(row);
  }
  folder.permissions.forEach((p) => addPerm(p));
  $('#add-perm').addEventListener('click', () => addPerm());
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    await api(`/api/folders/${folder.id}`, { method: 'PATCH', body: { name: f.get('name'), parent_id: f.get('parent_id') } });
    await api(`/api/folders/${folder.id}/permissions`, {
      method: 'PUT',
      body: {
        permissions: $$('.perm-editor', permsEl).map((row) => ({
          subject_type: $('[data-f=type]', row).value,
          subject_id: $('[data-f=subject]', row).value,
          level: $('[data-f=level]', row).value,
        })),
      },
    });
    toast('Dossier enregistré');
    location.hash = '#/admin?tab=folders';
  }));
}

function adminWorkflows(workflows, editId) {
  const editing = editId === 'new' ? { name: '', description: '', steps: [] } : workflows.find((w) => String(w.id) === editId);
  if (editing) {
    return html`
      <form id="wf-form" class="card">
        <h3>${editId === 'new' ? 'Nouveau workflow' : `Modifier « ${editing.name} »`}</h3>
        <div class="field"><label>Nom</label><input name="name" value="${editing.name}" required></div>
        <div class="field"><label>Description</label><input name="description" value="${editing.description}"></div>
        <label>Étapes (dans l'ordre)</label>
        <p class="hint">Cochez « en parallèle » pour qu'une étape se déroule en même temps que la précédente : toutes les étapes parallèles doivent être approuvées avant de passer à la suite. Le délai (en jours) déclenche une relance par courriel une fois dépassé.</p>
        <div id="steps"></div>
        <div class="actions" style="margin:8px 0 16px"><button type="button" class="ghost small" id="add-step">+ Ajouter une étape</button></div>
        <div class="actions"><button type="submit">Enregistrer</button><a class="button ghost" href="#/admin?tab=workflows">Annuler</a></div>
      </form>`;
  }
  return html`
    <div class="actions" style="margin-bottom:12px"><a class="button" href="#/admin?tab=workflows&edit=new">+ Nouveau workflow</a></div>
    ${workflows.length ? '' : html`<div class="empty">Aucun workflow.</div>`}
    ${workflows.map((w) => html`
      <div class="card">
        <div class="actions" style="justify-content:space-between">
          <div><h3>${w.name}</h3><div class="hint">${w.description}</div></div>
          <div class="actions">
            <a class="button ghost small" href="#/admin?tab=workflows&edit=${w.id}">Modifier</a>
            <button class="danger small" data-delete-wf="${w.id}">Supprimer</button>
          </div>
        </div>
        <ol class="steps" style="margin-top:8px">${stages(w.steps).map((st) => html`<li>
          <span class="num">${st.number}</span>
          <div class="stage">
            ${st.steps.length > 1 ? html`<div class="parallel-label">En parallèle</div>` : ''}
            ${st.steps.map((s) => html`<div class="stage-step">${s.name}<div class="who">${s.assignee_label}${s.due_days ? html` · délai ${s.due_days} j` : ''}</div></div>`)}
          </div>
        </li>`)}</ol>
      </div>`)}`;
}

function bindWorkflows(workflows, users, groups, editId) {
  $$('[data-delete-wf]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Supprimer ce workflow ?')) return;
    await api(`/api/workflows/${b.dataset.deleteWf}`, { method: 'DELETE' });
    await renderAdmin({ tab: 'workflows' });
  })));
  const form = $('#wf-form');
  if (!form) return;

  const editing = editId === 'new' ? { steps: [] } : workflows.find((w) => String(w.id) === editId);
  const stepsEl = $('#steps');
  const assigneeOptions = (type, selected) =>
    (type === 'user' ? users.map((u) => [u.id, u.display_name]) : groups.map((g) => [g.id, g.name])).map(([id, label]) => option(id, label, selected));

  function addStep(step = { name: '', assignee_type: 'user', assignee_id: null, due_days: null }, parallel = false) {
    const row = document.createElement('div');
    row.className = 'step-editor';
    row.innerHTML = fmt(html`
      <input data-f="name" placeholder="Nom de l'étape" value="${step.name}" required>
      <select data-f="type">${option('user', 'Utilisateur', step.assignee_type)}${option('group', 'Groupe', step.assignee_type)}</select>
      <select data-f="assignee">${assigneeOptions(step.assignee_type, step.assignee_id)}</select>
      <input data-f="due" type="number" min="1" max="365" placeholder="Délai (j)" value="${step.due_days ?? ''}">
      <label class="inline"><input type="checkbox" data-f="parallel" ${parallel ? raw('checked') : ''}> en parallèle</label>
      <button type="button" class="ghost small" data-f="remove" title="Retirer">✕</button>`);
    $('[data-f=type]', row).addEventListener('change', (e) => ($('[data-f=assignee]', row).innerHTML = fmt(assigneeOptions(e.target.value, null))));
    $('[data-f=remove]', row).addEventListener('click', () => row.remove());
    stepsEl.append(row);
  }

  if (editing.steps.length) editing.steps.forEach((s, i) => addStep(s, i > 0 && s.position === editing.steps[i - 1].position));
  else addStep();
  $('#add-step').addEventListener('click', () => addStep());
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      name: f.get('name'),
      description: f.get('description'),
      steps: $$('.step-editor', stepsEl).map((row) => ({
        name: $('[data-f=name]', row).value,
        assignee_type: $('[data-f=type]', row).value,
        assignee_id: $('[data-f=assignee]', row).value,
        due_days: $('[data-f=due]', row).value || null,
        parallel: $('[data-f=parallel]', row).checked,
      })),
    };
    if (editId === 'new') await api('/api/workflows', { method: 'POST', body });
    else await api(`/api/workflows/${editId}`, { method: 'PUT', body });
    toast('Workflow enregistré');
    location.hash = '#/admin?tab=workflows';
  }));
}

// ---------- Router ----------

async function route() {
  if (!me) return;
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const parts = path.split('/').filter(Boolean);
  const page = parts[0] ?? 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page));
  try {
    if (page === 'search') await renderSearch(params);
    else if (page === 'upload') await renderUpload();
    else if (page === 'doc' && parts[1]) await renderDocument(parts[1]);
    else if (page === 'admin') await renderAdmin(params);
    else if (page === 'profile') await renderProfile();
    else await renderDashboard();
  } catch (err) {
    if (me) render(html`<div class="empty">${err.message}</div>`);
  }
}

async function boot() {
  try {
    me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null));
  } catch {
    me = null;
  }
  if (!me) return renderLogin();
  $('#topbar').hidden = false;
  $('#whoami').textContent = me.display_name;
  $('#nav-admin').hidden = !me.is_admin;
  await route();
}

$('#logout').addEventListener('click', guard(async () => {
  await api('/api/logout', { method: 'POST' });
  me = null;
  location.hash = '';
  renderLogin();
}));
window.addEventListener('hashchange', route);
boot();
