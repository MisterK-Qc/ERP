const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');

const SCHEMA = `
PRAGMA foreign_keys = ON;

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

-- Each step is assigned either to a single user or to a group.
CREATE TABLE IF NOT EXISTS workflow_steps (
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'group')),
  assignee_id INTEGER NOT NULL,
  UNIQUE (workflow_id, position)
);

-- status: draft | in_progress | approved | rejected
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
`;

function openDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'archidoc.db'));
  db.exec(SCHEMA);
  seed(db);
  return db;
}

// Creates demo users, groups and a workflow on first launch.
function seed(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;

  const addUser = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)'
  );
  const admin = addUser.run('admin', 'Administrateur', hashPassword('admin'), 1).lastInsertRowid;
  const alice = addUser.run('alice', 'Alice Martin', hashPassword('alice'), 0).lastInsertRowid;
  const bob = addUser.run('bob', 'Bob Tremblay', hashPassword('bob'), 0).lastInsertRowid;

  const addGroup = db.prepare('INSERT INTO groups (name) VALUES (?)');
  const finance = addGroup.run('Finance').lastInsertRowid;
  const direction = addGroup.run('Direction').lastInsertRowid;

  const addMember = db.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)');
  addMember.run(bob, finance);
  addMember.run(admin, direction);

  const wf = db
    .prepare('INSERT INTO workflows (name, description) VALUES (?, ?)')
    .run('Approbation de facture', 'Vérification par un responsable, puis la Finance, puis la Direction')
    .lastInsertRowid;
  const addStep = db.prepare(
    'INSERT INTO workflow_steps (workflow_id, position, name, assignee_type, assignee_id) VALUES (?, ?, ?, ?, ?)'
  );
  addStep.run(wf, 1, 'Vérification', 'user', alice);
  addStep.run(wf, 2, 'Validation Finance', 'group', finance);
  addStep.run(wf, 3, 'Approbation Direction', 'group', direction);
}

module.exports = { openDatabase };
