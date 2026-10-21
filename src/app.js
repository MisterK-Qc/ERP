const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./db');
const { extractText } = require('./extract');
const { createNotifier } = require('./notify');
const { loadFolders, folderPath, folderLevel, readableFolderIds, descendantIds } = require('./access');
const {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  loadUser,
  requireAuth,
  requireAdmin,
} = require('./auth');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Only these types are rendered in the browser; everything else is forced to download
// so an uploaded HTML/SVG file can never run scripts on our origin.
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);
// Search snippets mark matches with these control characters; the UI turns them into <mark>.
const MARK_START = '\u0002';
const MARK_END = '\u0003';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ dataDir, mailTransport }) {
  const db = openDatabase(dataDir);
  const notifier = createNotifier(db, { transport: mailTransport });
  const filesDir = path.join(dataDir, 'files');
  const app = express();

  const upload = multer({
    storage: multer.diskStorage({
      destination: filesDir,
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.use(express.json());
  app.use(loadUser(db));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- Helpers ----------

  const addHistory = db.prepare(
    'INSERT INTO document_history (document_id, user_id, action, step_name, comment) VALUES (?, ?, ?, ?, ?)'
  );

  // Runs fn in a transaction. Side effects queued with defer() (e-mails) run only after commit.
  function inTransaction(fn) {
    const deferred = [];
    db.exec('BEGIN');
    let result;
    try {
      result = fn((effect) => deferred.push(effect));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    for (const effect of deferred) effect();
    return result;
  }

  function isAssignee(user, step) {
    if (step.assignee_type === 'user') return step.assignee_id === user.id;
    return user.group_ids.includes(step.assignee_id);
  }

  function assigneeLabel(type, id) {
    if (type === 'user') return db.prepare('SELECT display_name AS label FROM users WHERE id = ?').get(id)?.label ?? '?';
    const name = db.prepare('SELECT name FROM groups WHERE id = ?').get(id)?.name ?? '?';
    return `Groupe ${name}`;
  }

  function subjectExists(type, id) {
    return Boolean(db.prepare(`SELECT 1 FROM ${type === 'user' ? 'users' : 'groups'} WHERE id = ?`).get(Number(id)));
  }

  // SQL condition matching documents with a pending step assigned to the user (alias d).
  function assignedClause(user) {
    return {
      sql: `EXISTS (SELECT 1 FROM document_step_status x JOIN workflow_steps xs ON xs.id = x.step_id
                     WHERE x.document_id = d.id AND x.status = 'pending'
                       AND ((xs.assignee_type = 'user' AND xs.assignee_id = ?)
                         OR (xs.assignee_type = 'group' AND xs.assignee_id IN (SELECT value FROM json_each(?)))))`,
      params: [user.id, JSON.stringify(user.group_ids)],
    };
  }

  // SQL condition restricting documents to those the user may read (alias d).
  function visibilityClause(user, folders) {
    if (user.is_admin) return { sql: '1', params: [] };
    const assigned = assignedClause(user);
    return {
      sql: `(d.folder_id IS NULL OR d.folder_id IN (SELECT value FROM json_each(?)) OR d.uploaded_by = ? OR ${assigned.sql})`,
      params: [JSON.stringify(readableFolderIds(folders, user)), user.id, ...assigned.params],
    };
  }

  function docSelect(extraColumns = '', extraJoins = '') {
    return `
      SELECT d.id, d.title, d.description, d.tags, d.original_name, d.mime_type, d.size,
             d.status, d.workflow_id, d.current_step, d.current_version, d.folder_id,
             d.created_at, d.updated_at, d.uploaded_by, u.display_name AS uploaded_by_name,
             w.name AS workflow_name,
             (SELECT COUNT(DISTINCT ws.position) FROM workflow_steps ws WHERE ws.workflow_id = d.workflow_id) AS stage_total,
             (SELECT COUNT(DISTINCT ws.position) FROM workflow_steps ws
               WHERE ws.workflow_id = d.workflow_id AND ws.position <= d.current_step) AS stage_index
             ${extraColumns}
        FROM documents d
        JOIN users u ON u.id = d.uploaded_by
        LEFT JOIN workflows w ON w.id = d.workflow_id
        ${extraJoins}`;
  }

  const currentStepsQuery = db.prepare(
    `SELECT s.id, s.name, s.assignee_type, s.assignee_id, x.status, x.due_at,
            (x.status = 'pending' AND x.due_at IS NOT NULL AND x.due_at < datetime('now')) AS overdue
       FROM document_step_status x JOIN workflow_steps s ON s.id = x.step_id
      WHERE x.document_id = ? AND s.position = ? ORDER BY s.id`
  );

  function decorate(doc, folders) {
    doc.folder_path = doc.folder_id ? folderPath(folders, doc.folder_id) : '';
    doc.current_steps =
      doc.status === 'in_progress'
        ? currentStepsQuery.all(doc.id, doc.current_step).map((s) => ({
            ...s,
            overdue: Boolean(s.overdue),
            assignee_label: assigneeLabel(s.assignee_type, s.assignee_id),
          }))
        : [];
    doc.overdue = doc.current_steps.some((s) => s.overdue);
    return doc;
  }

  function pendingStepsFor(user, docId) {
    return db
      .prepare(
        `SELECT s.*, x.due_at FROM document_step_status x JOIN workflow_steps s ON s.id = x.step_id
          WHERE x.document_id = ? AND x.status = 'pending' ORDER BY s.id`
      )
      .all(docId)
      .filter((s) => isAssignee(user, s));
  }

  function canRead(user, doc, folders) {
    return (
      user.is_admin ||
      doc.uploaded_by === user.id ||
      Boolean(folderLevel(folders, user, doc.folder_id)) ||
      pendingStepsFor(user, doc.id).length > 0
    );
  }

  function canWrite(user, doc, folders) {
    return (
      user.is_admin ||
      doc.uploaded_by === user.id ||
      (doc.folder_id != null && folderLevel(folders, user, doc.folder_id) === 'write')
    );
  }

  // Loads a document the user is allowed to read; unreadable documents look missing.
  // `skipAccess` is only for replying to an action the user was just allowed to perform.
  function getDocument(user, id, { skipAccess = false } = {}) {
    const folders = loadFolders(db);
    const doc = db.prepare(`${docSelect()} WHERE d.id = ?`).get(Number(id));
    if (!doc || (!skipAccess && !canRead(user, doc, folders))) throw new HttpError(404, 'Document introuvable');
    return decorate(doc, folders);
  }

  function requireWritableFolder(user, folderId) {
    if (folderId == null) return;
    const folders = loadFolders(db);
    if (!folders.has(folderId)) throw new HttpError(400, 'Dossier introuvable');
    if (folderLevel(folders, user, folderId) !== 'write') {
      throw new HttpError(403, "Vous n'avez pas le droit d'écrire dans ce dossier");
    }
  }

  function parseFolderId(value) {
    return value === undefined || value === null || value === '' ? null : Number(value);
  }

  function syncFts(docId) {
    db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(docId);
    db.prepare(
      `INSERT INTO documents_fts (rowid, title, description, tags, original_name, content)
       SELECT id, title, description, tags, original_name, content_text FROM documents WHERE id = ?`
    ).run(docId);
  }

  function getWorkflow(id) {
    const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    if (!wf) return null;
    wf.steps = db
      .prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position, id')
      .all(id)
      .map((s) => ({ ...s, assignee_label: assigneeLabel(s.assignee_type, s.assignee_id) }));
    return wf;
  }

  function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) throw new HttpError(400, 'Au moins une étape est requise');
    for (const s of steps) {
      if (!s.name?.trim()) throw new HttpError(400, 'Chaque étape doit avoir un nom');
      if (!['user', 'group'].includes(s.assignee_type)) throw new HttpError(400, "Type d'assignation invalide");
      if (!subjectExists(s.assignee_type, s.assignee_id)) {
        throw new HttpError(400, `Assigné introuvable pour l'étape « ${s.name} »`);
      }
      const due = s.due_days;
      if (due != null && due !== '' && !(Number.isInteger(Number(due)) && Number(due) >= 1 && Number(due) <= 365)) {
        throw new HttpError(400, `Délai invalide pour l'étape « ${s.name} » (1 à 365 jours)`);
      }
    }
  }

  // A step flagged `parallel` shares the stage (position) of the step before it.
  function replaceSteps(workflowId, steps) {
    db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflowId);
    const insert = db.prepare(
      'INSERT INTO workflow_steps (workflow_id, position, name, assignee_type, assignee_id, due_days) VALUES (?, ?, ?, ?, ?, ?)'
    );
    let position = 0;
    steps.forEach((s, i) => {
      if (i === 0 || !s.parallel) position++;
      const due = s.due_days == null || s.due_days === '' ? null : Number(s.due_days);
      insert.run(workflowId, position, s.name.trim(), s.assignee_type, Number(s.assignee_id), due);
    });
  }

  // ---------- Workflow engine ----------

  function startStage(docId, position, defer) {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    const steps = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? AND position = ?').all(doc.workflow_id, position);
    const upsert = db.prepare(
      `INSERT INTO document_step_status (document_id, step_id, status, started_at, due_at)
       VALUES (?, ?, 'pending', datetime('now'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' days') END)
       ON CONFLICT (document_id, step_id) DO UPDATE SET
         status = 'pending', acted_by = NULL, acted_at = NULL, reminded_at = NULL,
         started_at = excluded.started_at, due_at = excluded.due_at
       RETURNING due_at`
    );
    for (const step of steps) {
      const { due_at } = upsert.get(docId, step.id, step.due_days, step.due_days);
      defer(() => notifier.stepAssigned(doc, { ...step, due_at }));
    }
  }

  function startWorkflow(docId, workflowId, userId, defer) {
    const wf = getWorkflow(workflowId);
    if (!wf) throw new HttpError(400, 'Workflow introuvable');
    if (wf.steps.length === 0) throw new HttpError(400, "Ce workflow n'a aucune étape");
    const first = wf.steps[0].position;
    db.prepare('DELETE FROM document_step_status WHERE document_id = ?').run(docId);
    db.prepare(
      `UPDATE documents SET workflow_id = ?, current_step = ?, status = 'in_progress', updated_at = datetime('now') WHERE id = ?`
    ).run(workflowId, first, docId);
    addHistory.run(docId, userId, 'workflow_started', null, `Workflow « ${wf.name} » démarré`);
    startStage(docId, first, defer);
  }

  function approve(user, doc, comment, defer) {
    const mine = pendingStepsFor(user, doc.id);
    if (!mine.length) throw new HttpError(403, "Vous n'êtes assigné à aucune étape en attente");
    const markApproved = db.prepare(
      `UPDATE document_step_status SET status = 'approved', acted_by = ?, acted_at = datetime('now')
        WHERE document_id = ? AND step_id = ?`
    );
    for (const step of mine) {
      markApproved.run(user.id, doc.id, step.id);
      addHistory.run(doc.id, user.id, 'approved_step', step.name, comment);
    }
    const { n: remaining } = db
      .prepare(`SELECT COUNT(*) AS n FROM document_step_status WHERE document_id = ? AND status = 'pending'`)
      .get(doc.id);
    if (remaining > 0) {
      db.prepare(`UPDATE documents SET updated_at = datetime('now') WHERE id = ?`).run(doc.id);
      return;
    }
    const { next } = db
      .prepare('SELECT MIN(position) AS next FROM workflow_steps WHERE workflow_id = ? AND position > ?')
      .get(doc.workflow_id, doc.current_step);
    if (next == null) {
      db.prepare(`UPDATE documents SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(doc.id);
      addHistory.run(doc.id, null, 'completed', null, 'Workflow terminé — document approuvé');
      defer(() => notifier.approved(doc));
    } else {
      db.prepare(`UPDATE documents SET current_step = ?, updated_at = datetime('now') WHERE id = ?`).run(next, doc.id);
      startStage(doc.id, next, defer);
    }
  }

  function reject(user, doc, comment, defer) {
    const mine = pendingStepsFor(user, doc.id);
    if (!mine.length) throw new HttpError(403, "Vous n'êtes assigné à aucune étape en attente");
    if (!comment) throw new HttpError(400, 'Un motif de rejet est requis');
    const markRejected = db.prepare(
      `UPDATE document_step_status SET status = 'rejected', acted_by = ?, acted_at = datetime('now')
        WHERE document_id = ? AND step_id = ?`
    );
    for (const step of mine) markRejected.run(user.id, doc.id, step.id);
    db.prepare(`UPDATE document_step_status SET status = 'skipped' WHERE document_id = ? AND status = 'pending'`).run(doc.id);
    db.prepare(`UPDATE documents SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(doc.id);
    addHistory.run(doc.id, user.id, 'rejected', mine[0].name, comment);
    defer(() => notifier.rejected(doc, mine[0], user, comment));
  }

  // Sends one reminder per overdue pending step. Called periodically by the server.
  function runReminders() {
    const overdue = db
      .prepare(
        `SELECT x.document_id, x.due_at, s.*, d.title, d.uploaded_by
           FROM document_step_status x
           JOIN workflow_steps s ON s.id = x.step_id
           JOIN documents d ON d.id = x.document_id
          WHERE x.status = 'pending' AND x.due_at IS NOT NULL AND x.due_at < datetime('now') AND x.reminded_at IS NULL`
      )
      .all();
    const mark = db.prepare(
      `UPDATE document_step_status SET reminded_at = datetime('now') WHERE document_id = ? AND step_id = ?`
    );
    for (const row of overdue) {
      mark.run(row.document_id, row.id);
      notifier.stepOverdue({ id: row.document_id, title: row.title, uploaded_by: row.uploaded_by }, row);
    }
    return overdue.length;
  }

  // Stores the text of an uploaded file for full-text search, removing the file if anything fails.
  async function withUpload(req, fn) {
    if (!req.file) throw new HttpError(400, 'Fichier requis');
    try {
      // Browsers send UTF-8 filenames but busboy decodes them as latin1.
      const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const mimeType = req.file.mimetype || 'application/octet-stream';
      const text = await extractText(req.file.path, mimeType, originalName);
      return fn({ originalName, mimeType, text, size: req.file.size, storageName: req.file.filename });
    } catch (err) {
      fs.rm(req.file.path, { force: true }, () => {});
      throw err;
    }
  }

  // ---------- Auth ----------

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
    if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Identifiants invalides');
    }
    const { token, maxAge } = createSession(db, user.id);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.use('/api', requireAuth);

  app.get('/api/me', (req, res) => {
    const { email, notify_email } = db.prepare('SELECT email, notify_email FROM users WHERE id = ?').get(req.user.id);
    res.json({ ...req.user, email, notify_email: Boolean(notify_email) });
  });

  app.patch('/api/me', (req, res) => {
    const { display_name, email, notify_email } = req.body ?? {};
    if (display_name?.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), req.user.id);
    if (email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(validEmail(email), req.user.id);
    if (typeof notify_email === 'boolean') {
      db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(notify_email ? 1 : 0, req.user.id);
    }
    res.json({ ok: true });
  });

  app.post('/api/me/password', (req, res) => {
    const { current, next } = req.body ?? {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(current ?? ''), row.password_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect');
    if (!next || String(next).length < 4) throw new HttpError(400, 'Nouveau mot de passe trop court');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(next)), req.user.id);
    res.json({ ok: true });
  });

  // ---------- Users & groups ----------

  app.get('/api/users', (req, res) => {
    const users = db.prepare('SELECT id, username, display_name, is_admin, email, notify_email FROM users ORDER BY display_name').all();
    const memberships = db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?');
    res.json(
      users.map((u) => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        is_admin: Boolean(u.is_admin),
        group_ids: memberships.all(u.id).map((m) => m.group_id),
        ...(req.user.is_admin ? { email: u.email, notify_email: Boolean(u.notify_email) } : {}),
      }))
    );
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    const { username, display_name, password, is_admin, email = '' } = req.body ?? {};
    if (!username?.trim() || !display_name?.trim() || !password) throw new HttpError(400, 'Champs requis manquants');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim())) {
      throw new HttpError(409, "Ce nom d'utilisateur existe déjà");
    }
    const id = db
      .prepare('INSERT INTO users (username, display_name, password_hash, is_admin, email) VALUES (?, ?, ?, ?, ?)')
      .run(username.trim(), display_name.trim(), hashPassword(String(password)), is_admin ? 1 : 0, validEmail(email)).lastInsertRowid;
    res.status(201).json({ id });
  });

  app.patch('/api/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { display_name, password, is_admin, email } = req.body ?? {};
    if (display_name?.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), id);
    if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), id);
    if (email !== undefined) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(validEmail(email), id);
    if (typeof is_admin === 'boolean') {
      if (id === req.user.id && !is_admin) throw new HttpError(400, 'Impossible de retirer vos propres droits admin');
      db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, id);
    }
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'Impossible de supprimer votre propre compte');
    if (db.prepare("SELECT 1 FROM workflow_steps WHERE assignee_type = 'user' AND assignee_id = ?").get(id)) {
      throw new HttpError(409, 'Cet utilisateur est assigné à une étape de workflow');
    }
    if (db.prepare('SELECT 1 FROM documents WHERE uploaded_by = ?').get(id)) {
      throw new HttpError(409, 'Cet utilisateur a déposé des documents');
    }
    inTransaction(() => {
      db.prepare("DELETE FROM folder_permissions WHERE subject_type = 'user' AND subject_id = ?").run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    res.json({ ok: true });
  });

  app.get('/api/groups', (_req, res) => {
    const groups = db.prepare('SELECT * FROM groups ORDER BY name').all();
    const members = db.prepare(
      'SELECT u.id, u.display_name FROM user_groups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = ? ORDER BY u.display_name'
    );
    res.json(groups.map((g) => ({ ...g, members: members.all(g.id) })));
  });

  app.post('/api/groups', requireAdmin, (req, res) => {
    const name = req.body?.name?.trim();
    if (!name) throw new HttpError(400, 'Nom requis');
    if (db.prepare('SELECT 1 FROM groups WHERE name = ?').get(name)) throw new HttpError(409, 'Ce groupe existe déjà');
    res.status(201).json({ id: db.prepare('INSERT INTO groups (name) VALUES (?)').run(name).lastInsertRowid });
  });

  app.put('/api/groups/:id/members', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const userIds = (req.body?.user_ids ?? []).map(Number);
    inTransaction(() => {
      db.prepare('DELETE FROM user_groups WHERE group_id = ?').run(id);
      const insert = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)');
      for (const uid of new Set(userIds)) insert.run(uid, id);
    });
    res.json({ ok: true });
  });

  app.delete('/api/groups/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare("SELECT 1 FROM workflow_steps WHERE assignee_type = 'group' AND assignee_id = ?").get(id)) {
      throw new HttpError(409, 'Ce groupe est assigné à une étape de workflow');
    }
    inTransaction(() => {
      db.prepare("DELETE FROM folder_permissions WHERE subject_type = 'group' AND subject_id = ?").run(id);
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    });
    res.json({ ok: true });
  });

  // ---------- Folders ----------

  app.get('/api/folders', (req, res) => {
    const folders = loadFolders(db);
    const counts = new Map(
      db.prepare('SELECT folder_id, COUNT(*) AS n FROM documents WHERE folder_id IS NOT NULL GROUP BY folder_id').all().map((r) => [r.folder_id, r.n])
    );
    const list = [...folders.values()]
      .map((f) => ({
        id: f.id,
        name: f.name,
        parent_id: f.parent_id,
        path: folderPath(folders, f.id),
        level: folderLevel(folders, req.user, f.id),
        document_count: counts.get(f.id) ?? 0,
        ...(req.user.is_admin
          ? { permissions: f.permissions.map((p) => ({ ...p, label: assigneeLabel(p.subject_type, p.subject_id) })) }
          : {}),
      }))
      .filter((f) => f.level)
      .sort((a, b) => a.path.localeCompare(b.path, 'fr'));
    res.json(list);
  });

  function validateFolderName(name, parentId, exceptId = null) {
    if (!name?.trim()) throw new HttpError(400, 'Nom requis');
    const clash = db
      .prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ? AND id IS NOT ?')
      .get(name.trim(), parentId, exceptId);
    if (clash) throw new HttpError(409, 'Un dossier de ce nom existe déjà à cet endroit');
  }

  app.post('/api/folders', requireAdmin, (req, res) => {
    const parentId = parseFolderId(req.body?.parent_id);
    if (parentId != null && !db.prepare('SELECT 1 FROM folders WHERE id = ?').get(parentId)) {
      throw new HttpError(400, 'Dossier parent introuvable');
    }
    validateFolderName(req.body?.name, parentId);
    const id = db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(req.body.name.trim(), parentId).lastInsertRowid;
    res.status(201).json({ id });
  });

  app.patch('/api/folders/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const folders = loadFolders(db);
    const folder = folders.get(id);
    if (!folder) throw new HttpError(404, 'Dossier introuvable');
    const parentId = req.body?.parent_id !== undefined ? parseFolderId(req.body.parent_id) : folder.parent_id;
    if (parentId != null && (!folders.has(parentId) || descendantIds(folders, id).includes(parentId))) {
      throw new HttpError(400, 'Dossier parent invalide');
    }
    const name = req.body?.name ?? folder.name;
    validateFolderName(name, parentId, id);
    db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name.trim(), parentId, id);
    res.json({ ok: true });
  });

  app.delete('/api/folders/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM folders WHERE parent_id = ?').get(id)) throw new HttpError(409, 'Ce dossier contient des sous-dossiers');
    if (db.prepare('SELECT 1 FROM documents WHERE folder_id = ?').get(id)) throw new HttpError(409, 'Ce dossier contient des documents');
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  app.put('/api/folders/:id/permissions', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM folders WHERE id = ?').get(id)) throw new HttpError(404, 'Dossier introuvable');
    const permissions = req.body?.permissions ?? [];
    if (!Array.isArray(permissions)) throw new HttpError(400, 'Liste de permissions invalide');
    for (const p of permissions) {
      if (!['user', 'group'].includes(p.subject_type) || !subjectExists(p.subject_type, p.subject_id)) {
        throw new HttpError(400, 'Utilisateur ou groupe introuvable');
      }
      if (!['read', 'write'].includes(p.level)) throw new HttpError(400, 'Niveau de permission invalide');
    }
    inTransaction(() => {
      db.prepare('DELETE FROM folder_permissions WHERE folder_id = ?').run(id);
      const insert = db.prepare(
        `INSERT INTO folder_permissions (folder_id, subject_type, subject_id, level) VALUES (?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET level = excluded.level`
      );
      for (const p of permissions) insert.run(id, p.subject_type, Number(p.subject_id), p.level);
    });
    res.json({ ok: true });
  });

  // ---------- Workflows ----------

  app.get('/api/workflows', (_req, res) => {
    const ids = db.prepare('SELECT id FROM workflows ORDER BY name').all();
    res.json(ids.map(({ id }) => getWorkflow(id)));
  });

  app.post('/api/workflows', requireAdmin, (req, res) => {
    const { name, description = '', steps } = req.body ?? {};
    if (!name?.trim()) throw new HttpError(400, 'Nom requis');
    if (db.prepare('SELECT 1 FROM workflows WHERE name = ?').get(name.trim())) {
      throw new HttpError(409, 'Un workflow porte déjà ce nom');
    }
    validateSteps(steps);
    const id = inTransaction(() => {
      const wfId = db.prepare('INSERT INTO workflows (name, description) VALUES (?, ?)').run(name.trim(), description).lastInsertRowid;
      replaceSteps(wfId, steps);
      return wfId;
    });
    res.status(201).json(getWorkflow(id));
  });

  app.put('/api/workflows/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!getWorkflow(id)) throw new HttpError(404, 'Workflow introuvable');
    const { name, description = '', steps } = req.body ?? {};
    if (!name?.trim()) throw new HttpError(400, 'Nom requis');
    validateSteps(steps);
    if (db.prepare("SELECT 1 FROM documents WHERE workflow_id = ? AND status = 'in_progress'").get(id)) {
      throw new HttpError(409, 'Des documents sont en cours dans ce workflow');
    }
    inTransaction(() => {
      db.prepare('UPDATE workflows SET name = ?, description = ? WHERE id = ?').run(name.trim(), description, id);
      replaceSteps(id, steps);
    });
    res.json(getWorkflow(id));
  });

  app.delete('/api/workflows/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare("SELECT 1 FROM documents WHERE workflow_id = ? AND status = 'in_progress'").get(id)) {
      throw new HttpError(409, 'Des documents sont en cours dans ce workflow');
    }
    db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---------- Documents ----------

  app.post('/api/documents', upload.single('file'), async (req, res) => {
    const { title, description = '', tags = '', workflow_id } = req.body ?? {};
    const folderId = parseFolderId(req.body?.folder_id);
    const id = await withUpload(req, (file) => {
      requireWritableFolder(req.user, folderId);
      return inTransaction((defer) => {
        const docId = db
          .prepare(
            `INSERT INTO documents (title, description, tags, original_name, mime_type, size, storage_name, uploaded_by, folder_id, content_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            title?.trim() || file.originalName,
            description,
            normalizeTags(tags),
            file.originalName,
            file.mimeType,
            file.size,
            file.storageName,
            req.user.id,
            folderId,
            file.text
          ).lastInsertRowid;
        db.prepare(
          `INSERT INTO document_versions (document_id, version, original_name, mime_type, size, storage_name, uploaded_by)
           VALUES (?, 1, ?, ?, ?, ?, ?)`
        ).run(docId, file.originalName, file.mimeType, file.size, file.storageName, req.user.id);
        addHistory.run(docId, req.user.id, 'uploaded', null, '');
        syncFts(docId);
        if (workflow_id) startWorkflow(docId, Number(workflow_id), req.user.id, defer);
        return docId;
      });
    });
    res.status(201).json(getDocument(req.user, id));
  });

  app.post('/api/documents/:id/versions', upload.single('file'), async (req, res) => {
    let doc;
    try {
      doc = getDocument(req.user, req.params.id);
      if (!canWrite(req.user, doc, loadFolders(db))) throw new HttpError(403, 'Action non autorisée');
    } catch (err) {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      throw err;
    }
    const comment = String(req.body?.comment ?? '').trim();
    await withUpload(req, (file) =>
      inTransaction(() => {
        const version = doc.current_version + 1;
        db.prepare(
          `INSERT INTO document_versions (document_id, version, original_name, mime_type, size, storage_name, uploaded_by, comment)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(doc.id, version, file.originalName, file.mimeType, file.size, file.storageName, req.user.id, comment);
        db.prepare(
          `UPDATE documents SET original_name = ?, mime_type = ?, size = ?, storage_name = ?, current_version = ?,
                  content_text = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(file.originalName, file.mimeType, file.size, file.storageName, version, file.text, doc.id);
        addHistory.run(doc.id, req.user.id, 'new_version', null, comment ? `Version ${version} : ${comment}` : `Version ${version}`);
        syncFts(doc.id);
      })
    );
    res.status(201).json(getDocument(req.user, doc.id));
  });

  // Search: every word of `q` must match (as a prefix, accents ignored) the title, description,
  // tags, file name or extracted file content.
  app.get('/api/documents', (req, res) => {
    const folders = loadFolders(db);
    const visibility = visibilityClause(req.user, folders);
    const where = [visibility.sql];
    const params = [];
    let joins = '';
    let columns = ', NULL AS snippet';
    let order = 'd.updated_at DESC, d.id DESC';

    const match = ftsQuery(req.query.q);
    if (match) {
      columns = ', f.snippet';
      joins = `JOIN (SELECT rowid AS fid, rank AS frank,
                            snippet(documents_fts, -1, '${MARK_START}', '${MARK_END}', '…', 20) AS snippet
                       FROM documents_fts WHERE documents_fts MATCH ?) f ON f.fid = d.id`;
      params.push(match);
      order = 'f.frank, d.updated_at DESC';
    } else if (String(req.query.q ?? '').trim()) {
      return res.json([]);
    }
    params.push(...visibility.params);

    if (req.query.status) {
      where.push('d.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.workflow_id) {
      where.push('d.workflow_id = ?');
      params.push(Number(req.query.workflow_id));
    }
    if (req.query.uploaded_by) {
      where.push('d.uploaded_by = ?');
      params.push(Number(req.query.uploaded_by));
    }
    if (req.query.folder_id === 'none') {
      where.push('d.folder_id IS NULL');
    } else if (req.query.folder_id) {
      where.push('d.folder_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(descendantIds(folders, Number(req.query.folder_id))));
    }
    if (req.query.from) {
      where.push('date(d.created_at) >= date(?)');
      params.push(String(req.query.from));
    }
    if (req.query.to) {
      where.push('date(d.created_at) <= date(?)');
      params.push(String(req.query.to));
    }
    const sql = `${docSelect(columns, joins)} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`;
    res.json(db.prepare(sql).all(...params).map((d) => decorate(d, folders)));
  });

  app.get('/api/dashboard', (req, res) => {
    const folders = loadFolders(db);
    const assigned = assignedClause(req.user);
    const visibility = visibilityClause(req.user, folders);
    const todo = db
      .prepare(`${docSelect()} WHERE d.status = 'in_progress' AND ${assigned.sql} ORDER BY d.updated_at ASC`)
      .all(...assigned.params)
      .map((d) => decorate(d, folders))
      .sort((a, b) => b.overdue - a.overdue);
    const mine = db
      .prepare(`${docSelect()} WHERE d.uploaded_by = ? ORDER BY d.updated_at DESC LIMIT 20`)
      .all(req.user.id)
      .map((d) => decorate(d, folders));
    const counts = Object.fromEntries(
      db
        .prepare(`SELECT d.status, COUNT(*) AS n FROM documents d WHERE ${visibility.sql} GROUP BY d.status`)
        .all(...visibility.params)
        .map((r) => [r.status, r.n])
    );
    res.json({ assigned: todo, mine, counts });
  });

  app.get('/api/documents/:id', (req, res) => {
    const folders = loadFolders(db);
    const doc = getDocument(req.user, req.params.id);
    if (doc.workflow_id) {
      doc.workflow = getWorkflow(doc.workflow_id);
      const statuses = new Map(
        db
          .prepare(
            `SELECT x.*, u.display_name AS acted_by_name FROM document_step_status x
               LEFT JOIN users u ON u.id = x.acted_by WHERE x.document_id = ?`
          )
          .all(doc.id)
          .map((x) => [x.step_id, x])
      );
      for (const step of doc.workflow?.steps ?? []) {
        const s = statuses.get(step.id);
        step.status = s?.status ?? (doc.status === 'approved' || step.position < doc.current_step ? 'approved' : 'todo');
        Object.assign(step, { acted_by_name: s?.acted_by_name, acted_at: s?.acted_at, due_at: s?.due_at });
      }
    }
    doc.versions = db
      .prepare(
        `SELECT v.version, v.original_name, v.mime_type, v.size, v.comment, v.created_at, u.display_name AS uploaded_by_name
           FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by
          WHERE v.document_id = ? ORDER BY v.version DESC`
      )
      .all(doc.id);
    doc.history = db
      .prepare(
        `SELECT h.*, u.display_name AS user_name FROM document_history h
           LEFT JOIN users u ON u.id = h.user_id
          WHERE h.document_id = ? ORDER BY h.id`
      )
      .all(doc.id);
    const writable = canWrite(req.user, doc, folders);
    doc.my_steps = doc.status === 'in_progress' ? pendingStepsFor(req.user, doc.id).map((s) => s.name) : [];
    doc.can_act = doc.my_steps.length > 0;
    doc.can_edit = writable;
    doc.can_start = writable && doc.status !== 'in_progress';
    doc.can_delete = req.user.is_admin || (doc.uploaded_by === req.user.id && doc.status === 'draft');
    res.json(doc);
  });

  app.get('/api/documents/:id/file', (req, res) => {
    const doc = getDocument(req.user, req.params.id);
    const version = req.query.version ? Number(req.query.version) : doc.current_version;
    const file = db.prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(doc.id, version);
    if (!file) throw new HttpError(404, 'Version introuvable');
    const inline = req.query.inline === '1' && INLINE_TYPES.has(file.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.attachment(file.original_name);
    if (inline) res.setHeader('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    res.type(inline ? file.mime_type : 'application/octet-stream');
    res.sendFile(path.join(filesDir, file.storage_name));
  });

  app.patch('/api/documents/:id', (req, res) => {
    const doc = getDocument(req.user, req.params.id);
    if (!canWrite(req.user, doc, loadFolders(db))) throw new HttpError(403, 'Action non autorisée');
    const { title, description, tags } = req.body ?? {};
    let folderId = doc.folder_id;
    if (req.body?.folder_id !== undefined) {
      folderId = parseFolderId(req.body.folder_id);
      if (folderId !== doc.folder_id) requireWritableFolder(req.user, folderId);
    }
    inTransaction(() => {
      db.prepare(
        `UPDATE documents SET title = ?, description = ?, tags = ?, folder_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(
        title?.trim() || doc.title,
        description ?? doc.description,
        tags != null ? normalizeTags(tags) : doc.tags,
        folderId,
        doc.id
      );
      addHistory.run(doc.id, req.user.id, 'edited', null, '');
      syncFts(doc.id);
    });
    res.json(getDocument(req.user, doc.id));
  });

  app.post('/api/documents/:id/start', (req, res) => {
    const doc = getDocument(req.user, req.params.id);
    if (!canWrite(req.user, doc, loadFolders(db))) throw new HttpError(403, 'Action non autorisée');
    if (doc.status === 'in_progress') throw new HttpError(409, 'Un workflow est déjà en cours');
    inTransaction((defer) => startWorkflow(doc.id, Number(req.body?.workflow_id), req.user.id, defer));
    res.json(getDocument(req.user, doc.id));
  });

  // Workflow actions: approve (the user's pending steps), reject (stops the workflow), or comment.
  app.post('/api/documents/:id/actions', (req, res) => {
    const doc = getDocument(req.user, req.params.id);
    const action = req.body?.action;
    const comment = String(req.body?.comment ?? '').trim();

    if (action === 'comment') {
      if (!comment) throw new HttpError(400, 'Commentaire vide');
      addHistory.run(doc.id, req.user.id, 'commented', null, comment);
      return res.json(getDocument(req.user, doc.id));
    }
    if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Action inconnue');
    if (doc.status !== 'in_progress') throw new HttpError(409, "Ce document n'est pas dans un workflow actif");
    inTransaction((defer) => (action === 'approve' ? approve : reject)(req.user, doc, comment, defer));
    // An assignee may lose access once their step is done, so reply with the result regardless.
    res.json(getDocument(req.user, doc.id, { skipAccess: true }));
  });

  app.delete('/api/documents/:id', (req, res) => {
    const doc = getDocument(req.user, req.params.id);
    if (!req.user.is_admin && !(doc.uploaded_by === req.user.id && doc.status === 'draft')) {
      throw new HttpError(403, 'Action non autorisée');
    }
    const files = db.prepare('SELECT storage_name FROM document_versions WHERE document_id = ?').all(doc.id);
    inTransaction(() => {
      db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(doc.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    });
    for (const f of files) fs.rm(path.join(filesDir, f.storage_name), { force: true }, () => {});
    res.json({ ok: true });
  });

  // ---------- Errors ----------

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Route inconnue')));

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (50 Mo max)' : err.message });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne' });
  });

  app.locals.db = db;
  app.locals.runReminders = runReminders;
  return app;
}

function normalizeTags(tags) {
  return String(tags)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .filter((t, i, all) => all.indexOf(t) === i)
    .join(', ');
}

function validEmail(email) {
  const value = String(email ?? '').trim();
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, 'Adresse courriel invalide');
  return value;
}

// Turns free text into an FTS5 query where every word must match as a prefix.
function ftsQuery(q) {
  const terms = String(q ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

module.exports = { createApp };
