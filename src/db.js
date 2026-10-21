const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');

// Each entry upgrades the schema by one version; PRAGMA user_version records the last one applied.
const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS workflow_steps (
    id INTEGER PRIMARY KEY,
    workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'group')),
    assignee_id INTEGER NOT NULL,
    UNIQUE (workflow_id, position)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_name TEXT NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
    current_step INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS document_history (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    step_name TEXT,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
  CREATE INDEX IF NOT EXISTS idx_history_document ON document_history(document_id);
  `,

  // 2 — folders & permissions, versions, content indexing, parallel steps, deadlines, e-mail
  `
  ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES folders(id)
  );

  -- A folder without entries inherits its parent's rules; the root is open to everyone.
  CREATE TABLE folder_permissions (
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group')),
    subject_id INTEGER NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('read', 'write')),
    PRIMARY KEY (folder_id, subject_type, subject_id)
  );

  ALTER TABLE documents ADD COLUMN folder_id INTEGER REFERENCES folders(id);
  ALTER TABLE documents ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE documents ADD COLUMN content_text TEXT NOT NULL DEFAULT '';

  CREATE TABLE document_versions (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_name TEXT NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (document_id, version)
  );
  INSERT INTO document_versions (document_id, version, original_name, mime_type, size, storage_name, uploaded_by, created_at)
    SELECT id, 1, original_name, mime_type, size, storage_name, uploaded_by, created_at FROM documents;

  -- Steps sharing a position form a parallel stage; all of them must approve.
  CREATE TABLE workflow_steps_v2 (
    id INTEGER PRIMARY KEY,
    workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'group')),
    assignee_id INTEGER NOT NULL,
    due_days INTEGER
  );
  INSERT INTO workflow_steps_v2 (id, workflow_id, position, name, assignee_type, assignee_id)
    SELECT id, workflow_id, position, name, assignee_type, assignee_id FROM workflow_steps;
  DROP TABLE workflow_steps;
  ALTER TABLE workflow_steps_v2 RENAME TO workflow_steps;
  CREATE INDEX idx_steps_workflow ON workflow_steps(workflow_id, position);

  -- status: pending | approved | skipped
  CREATE TABLE document_step_status (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    acted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    acted_at TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    due_at TEXT,
    reminded_at TEXT,
    PRIMARY KEY (document_id, step_id)
  );
  INSERT INTO document_step_status (document_id, step_id)
    SELECT d.id, s.id FROM documents d
      JOIN workflow_steps s ON s.workflow_id = d.workflow_id AND s.position = d.current_step
     WHERE d.status = 'in_progress';

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    title, description, tags, original_name, content,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO documents_fts (rowid, title, description, tags, original_name, content)
    SELECT id, title, description, tags, original_name, content_text FROM documents;
  `,
];

function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  // Table rebuilds in the migrations require foreign keys off; it cannot be toggled inside a transaction.
  db.exec('PRAGMA foreign_keys = OFF');
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
}

function openDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'archidoc.db'));
  migrate(db);
  seed(db);
  return db;
}

// Creates demo users, groups, folders and workflows on first launch.
function seed(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;

  const addUser = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, is_admin, email) VALUES (?, ?, ?, ?, ?)'
  );
  const admin = addUser.run('admin', 'Administrateur', hashPassword('admin'), 1, 'admin@example.com').lastInsertRowid;
  const alice = addUser.run('alice', 'Alice Martin', hashPassword('alice'), 0, 'alice@example.com').lastInsertRowid;
  const bob = addUser.run('bob', 'Bob Tremblay', hashPassword('bob'), 0, 'bob@example.com').lastInsertRowid;

  const addGroup = db.prepare('INSERT INTO groups (name) VALUES (?)');
  const finance = addGroup.run('Finance').lastInsertRowid;
  const direction = addGroup.run('Direction').lastInsertRowid;

  const addMember = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)');
  addMember.run(bob, finance);
  addMember.run(admin, direction);

  const addFolder = db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)');
  const factures = addFolder.run('Factures', null).lastInsertRowid;
  addFolder.run('Fournisseurs', factures);
  addFolder.run('Contrats', null);
  const rh = addFolder.run('Ressources humaines', null).lastInsertRowid;
  const addPerm = db.prepare(
    'INSERT INTO folder_permissions (folder_id, subject_type, subject_id, level) VALUES (?, ?, ?, ?)'
  );
  addPerm.run(rh, 'group', direction, 'write');
  addPerm.run(rh, 'user', alice, 'read');

  const addWorkflow = db.prepare('INSERT INTO workflows (name, description) VALUES (?, ?)');
  const addStep = db.prepare(
    'INSERT INTO workflow_steps (workflow_id, position, name, assignee_type, assignee_id, due_days) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const invoice = addWorkflow.run(
    'Approbation de facture',
    'Vérification par un responsable, puis la Finance, puis la Direction'
  ).lastInsertRowid;
  addStep.run(invoice, 1, 'Vérification', 'user', alice, 2);
  addStep.run(invoice, 2, 'Validation Finance', 'group', finance, 3);
  addStep.run(invoice, 3, 'Approbation Direction', 'group', direction, null);

  const contract = addWorkflow.run(
    'Revue de contrat',
    'Revues juridique et financière en parallèle, puis signature par la Direction'
  ).lastInsertRowid;
  addStep.run(contract, 1, 'Revue juridique', 'user', alice, 5);
  addStep.run(contract, 1, 'Revue financière', 'group', finance, 5);
  addStep.run(contract, 2, 'Signature', 'group', direction, 2);
}

module.exports = { openDatabase };
