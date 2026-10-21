const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./db');
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ dataDir }) {
  const db = openDatabase(dataDir);
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

  const stepAt = db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? AND position = ?');
  const stepCount = db.prepare('SELECT COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ?');
  const addHistory = db.prepare(
    'INSERT INTO document_history (document_id, user_id, action, step_name, comment) VALUES (?, ?, ?, ?, ?)'
  );

  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function isAssignee(user, step) {
    if (!step) return false;
    if (step.assignee_type === 'user') return step.assignee_id === user.id;
    return user.group_ids.includes(step.assignee_id);
  }

  function assigneeLabel(type, id) {
    if (type === 'user') return db.prepare('SELECT display_name AS label FROM users WHERE id = ?').get(id)?.label ?? '?';
    const name = db.prepare('SELECT name FROM groups WHERE id = ?').get(id)?.name ?? '?';
    return `Groupe ${name}`;
  }

  // Columns shared by every document listing, including the current step and who owns it.
  const DOC_SELECT = `
    SELECT d.id, d.title, d.description, d.tags, d.original_name, d.mime_type, d.size,
           d.status, d.workflow_id, d.current_step, d.created_at, d.updated_at,
           d.uploaded_by, u.display_name AS uploaded_by_name,
           w.name AS workflow_name,
           s.name AS step_name, s.assignee_type, s.assignee_id,
           (SELECT COUNT(*) FROM workflow_steps ws WHERE ws.workflow_id = d.workflow_id) AS step_total
      FROM documents d
      JOIN users u ON u.id = d.uploaded_by
      LEFT JOIN workflows w ON w.id = d.workflow_id
      LEFT JOIN workflow_steps s ON s.workflow_id = d.workflow_id AND s.position = d.current_step`;

  function decorate(doc) {
    if (doc.assignee_type) doc.assignee_label = assigneeLabel(doc.assignee_type, doc.assignee_id);
    return doc;
  }

  function getDocument(id) {
    const doc = db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id);
    if (!doc) throw new HttpError(404, 'Document introuvable');
    return decorate(doc);
  }

  function getWorkflow(id) {
    const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    if (!wf) return null;
    wf.steps = db
      .prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position')
      .all(id)
      .map((s) => ({ ...s, assignee_label: assigneeLabel(s.assignee_type, s.assignee_id) }));
    return wf;
  }

  function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) throw new HttpError(400, 'Au moins une étape est requise');
    for (const s of steps) {
      if (!s.name?.trim()) throw new HttpError(400, 'Chaque étape doit avoir un nom');
      if (!['user', 'group'].includes(s.assignee_type)) throw new HttpError(400, "Type d'assignation invalide");
      const table = s.assignee_type === 'user' ? 'users' : 'groups';
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(s.assignee_id))) {
        throw new HttpError(400, `Assigné introuvable pour l'étape « ${s.name} »`);
      }
    }
  }

  function replaceSteps(workflowId, steps) {
    db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflowId);
    const insert = db.prepare(
      'INSERT INTO workflow_steps (workflow_id, position, name, assignee_type, assignee_id) VALUES (?, ?, ?, ?, ?)'
    );
    steps.forEach((s, i) => insert.run(workflowId, i + 1, s.name.trim(), s.assignee_type, Number(s.assignee_id)));
  }

  function startWorkflow(docId, workflowId, userId) {
    const wf = getWorkflow(workflowId);
    if (!wf) throw new HttpError(400, 'Workflow introuvable');
    if (wf.steps.length === 0) throw new HttpError(400, "Ce workflow n'a aucune étape");
    db.prepare(
      `UPDATE documents SET workflow_id = ?, current_step = 1, status = 'in_progress', updated_at = datetime('now') WHERE id = ?`
    ).run(workflowId, docId);
    addHistory.run(docId, userId, 'workflow_started', null,`Workflow « ${wf.name} » démarré`);
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

  app.get('/api/me', (req, res) => res.json(req.user));

  app.post('/api/me/password', (req, res) => {
    const { current, next } = req.body ?? {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(current ?? ''), row.password_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect');
    if (!next || String(next).length < 4) throw new HttpError(400, 'Nouveau mot de passe trop court');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(next)), req.user.id);
    res.json({ ok: true });
  });

  // ---------- Users & groups ----------

  app.get('/api/users', (_req, res) => {
    const users = db.prepare('SELECT id, username, display_name, is_admin FROM users ORDER BY display_name').all();
    const memberships = db.prepare('SELECT group_id FROM user_groups WHERE user_id = ?');
    res.json(
      users.map((u) => ({ ...u, is_admin: Boolean(u.is_admin), group_ids: memberships.all(u.id).map((m) => m.group_id) }))
    );
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    const { username, display_name, password, is_admin } = req.body ?? {};
    if (!username?.trim() || !display_name?.trim() || !password) throw new HttpError(400, 'Champs requis manquants');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim())) {
      throw new HttpError(409, "Ce nom d'utilisateur existe déjà");
    }
    const id = db
      .prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)')
      .run(username.trim(), display_name.trim(), hashPassword(String(password)), is_admin ? 1 : 0).lastInsertRowid;
    res.status(201).json({ id });
  });

  app.patch('/api/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const { display_name, password, is_admin } = req.body ?? {};
    if (display_name?.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), id);
    if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), id);
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
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
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
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
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
      const wfId = db
        .prepare('INSERT INTO workflows (name, description) VALUES (?, ?)')
        .run(name.trim(), description).lastInsertRowid;
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

  app.post('/api/documents', upload.single('file'), (req, res) => {
    if (!req.file) throw new HttpError(400, 'Fichier requis');
    const { title, description = '', tags = '', workflow_id } = req.body;
    // Browsers send UTF-8 filenames but busboy decodes them as latin1.
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
      const id = inTransaction(() => {
        const docId = db
          .prepare(
            `INSERT INTO documents (title, description, tags, original_name, mime_type, size, storage_name, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            title?.trim() || originalName,
            description,
            normalizeTags(tags),
            originalName,
            req.file.mimetype || 'application/octet-stream',
            req.file.size,
            req.file.filename,
            req.user.id
          ).lastInsertRowid;
        addHistory.run(docId, req.user.id, 'uploaded', null, '');
        if (workflow_id) startWorkflow(docId, Number(workflow_id), req.user.id);
        return docId;
      });
      res.status(201).json(getDocument(id));
    } catch (err) {
      fs.rm(req.file.path, { force: true }, () => {});
      throw err;
    }
  });

  // Search: every word of `q` must appear in the title, description, tags or file name.
  app.get('/api/documents', (req, res) => {
    const where = [];
    const params = [];
    const terms = String(req.query.q ?? '').trim().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(
        `(d.title LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR d.tags LIKE ? ESCAPE '\\' OR d.original_name LIKE ? ESCAPE '\\')`
      );
      params.push(like, like, like, like);
    }
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
    if (req.query.from) {
      where.push('date(d.created_at) >= date(?)');
      params.push(String(req.query.from));
    }
    if (req.query.to) {
      where.push('date(d.created_at) <= date(?)');
      params.push(String(req.query.to));
    }
    const sql = `${DOC_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC, d.id DESC LIMIT 200`;
    res.json(db.prepare(sql).all(...params).map(decorate));
  });

  app.get('/api/dashboard', (req, res) => {
    const assigned = db
      .prepare(
        `${DOC_SELECT}
          WHERE d.status = 'in_progress'
            AND ((s.assignee_type = 'user' AND s.assignee_id = ?)
              OR (s.assignee_type = 'group' AND s.assignee_id IN (SELECT group_id FROM user_groups WHERE user_id = ?)))
          ORDER BY d.updated_at ASC`
      )
      .all(req.user.id, req.user.id)
      .map(decorate);
    const mine = db
      .prepare(`${DOC_SELECT} WHERE d.uploaded_by = ? ORDER BY d.updated_at DESC LIMIT 20`)
      .all(req.user.id)
      .map(decorate);
    const counts = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all().map((r) => [r.status, r.n])
    );
    res.json({ assigned, mine, counts });
  });

  app.get('/api/documents/:id', (req, res) => {
    const doc = getDocument(Number(req.params.id));
    doc.workflow = doc.workflow_id ? getWorkflow(doc.workflow_id) : null;
    doc.history = db
      .prepare(
        `SELECT h.*, u.display_name AS user_name FROM document_history h
           LEFT JOIN users u ON u.id = h.user_id
          WHERE h.document_id = ? ORDER BY h.id`
      )
      .all(doc.id);
    const step = doc.status === 'in_progress' ? stepAt.get(doc.workflow_id, doc.current_step) : null;
    doc.can_act = isAssignee(req.user, step);
    doc.can_start = ['draft', 'rejected', 'approved'].includes(doc.status) && (req.user.is_admin || doc.uploaded_by === req.user.id);
    doc.can_delete = req.user.is_admin || (doc.uploaded_by === req.user.id && doc.status === 'draft');
    res.json(doc);
  });

  app.get('/api/documents/:id/file', (req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) throw new HttpError(404, 'Document introuvable');
    const inline = req.query.inline === '1' && INLINE_TYPES.has(doc.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.attachment(doc.original_name);
    if (inline) res.setHeader('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    res.type(inline ? doc.mime_type : 'application/octet-stream');
    res.sendFile(path.join(filesDir, doc.storage_name));
  });

  app.patch('/api/documents/:id', (req, res) => {
    const doc = getDocument(Number(req.params.id));
    if (!req.user.is_admin && doc.uploaded_by !== req.user.id) throw new HttpError(403, 'Action non autorisée');
    const { title, description, tags } = req.body ?? {};
    db.prepare(
      `UPDATE documents SET title = ?, description = ?, tags = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(title?.trim() || doc.title, description ?? doc.description, tags != null ? normalizeTags(tags) : doc.tags, doc.id);
    addHistory.run(doc.id, req.user.id, 'edited', null, '');
    res.json(getDocument(doc.id));
  });

  app.post('/api/documents/:id/start', (req, res) => {
    const doc = getDocument(Number(req.params.id));
    if (!req.user.is_admin && doc.uploaded_by !== req.user.id) throw new HttpError(403, 'Action non autorisée');
    if (doc.status === 'in_progress') throw new HttpError(409, 'Un workflow est déjà en cours');
    inTransaction(() => startWorkflow(doc.id, Number(req.body?.workflow_id), req.user.id));
    res.json(getDocument(doc.id));
  });

  // Workflow actions on the current step: approve (advance), reject (stop), or comment.
  app.post('/api/documents/:id/actions', (req, res) => {
    const doc = getDocument(Number(req.params.id));
    const action = req.body?.action;
    const comment = String(req.body?.comment ?? '').trim();

    if (action === 'comment') {
      if (!comment) throw new HttpError(400, 'Commentaire vide');
      addHistory.run(doc.id, req.user.id, 'commented', doc.step_name, comment);
      return res.json(getDocument(doc.id));
    }
    if (!['approve', 'reject'].includes(action)) throw new HttpError(400, 'Action inconnue');
    if (doc.status !== 'in_progress') throw new HttpError(409, "Ce document n'est pas dans un workflow actif");
    const step = stepAt.get(doc.workflow_id, doc.current_step);
    if (!isAssignee(req.user, step)) throw new HttpError(403, "Vous n'êtes pas assigné à l'étape en cours");
    if (action === 'reject' && !comment) throw new HttpError(400, 'Un motif de rejet est requis');

    inTransaction(() => {
      if (action === 'reject') {
        db.prepare(`UPDATE documents SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(doc.id);
        addHistory.run(doc.id, req.user.id, 'rejected', step.name, comment);
        return;
      }
      addHistory.run(doc.id, req.user.id, 'approved_step', step.name, comment);
      const { n } = stepCount.get(doc.workflow_id);
      if (doc.current_step >= n) {
        db.prepare(`UPDATE documents SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(doc.id);
        addHistory.run(doc.id, null, 'completed', null, 'Workflow terminé — document approuvé');
      } else {
        db.prepare(
          `UPDATE documents SET current_step = current_step + 1, updated_at = datetime('now') WHERE id = ?`
        ).run(doc.id);
      }
    });
    res.json(getDocument(doc.id));
  });

  app.delete('/api/documents/:id', (req, res) => {
    const doc = getDocument(Number(req.params.id));
    if (!req.user.is_admin && !(doc.uploaded_by === req.user.id && doc.status === 'draft')) {
      throw new HttpError(403, 'Action non autorisée');
    }
    const { storage_name } = db.prepare('SELECT storage_name FROM documents WHERE id = ?').get(doc.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    fs.rm(path.join(filesDir, storage_name), { force: true }, () => {});
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

module.exports = { createApp };
