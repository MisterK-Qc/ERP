const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../src/db');

// Recreates a database as the first release left it, then upgrades it.
test('upgrades a version 1 database and keeps in-progress workflows', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archidoc-migration-'));
  try {
    const v1 = new DatabaseSync(path.join(dataDir, 'archidoc.db'));
    v1.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE workflows (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '');
      CREATE TABLE workflow_steps (id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, name TEXT NOT NULL, assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'group')),
        assignee_id INTEGER NOT NULL, UNIQUE (workflow_id, position));
      CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '', original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
        storage_name TEXT NOT NULL, uploaded_by INTEGER NOT NULL REFERENCES users(id),
        workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL, current_step INTEGER,
        status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'u', 'U', 'x:y');
      INSERT INTO workflows (id, name) VALUES (1, 'W');
      INSERT INTO workflow_steps (id, workflow_id, position, name, assignee_type, assignee_id) VALUES (1, 1, 1, 'A', 'user', 1), (2, 1, 2, 'B', 'user', 1);
      INSERT INTO documents (id, title, original_name, mime_type, size, storage_name, uploaded_by, workflow_id, current_step, status)
        VALUES (1, 'Ancien rapport', 'r.txt', 'text/plain', 1, 'abc', 1, 1, 2, 'in_progress');
    `);
    v1.close();

    const db = openDatabase(dataDir);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual({ ...db.prepare('SELECT step_id, status FROM document_step_status').get() }, { step_id: 2, status: 'pending' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM document_versions').get().n, 1);
    assert.equal(db.prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'rapport'").get().rowid, 1);
    // Parallel steps are now allowed.
    db.prepare("INSERT INTO workflow_steps (workflow_id, position, name, assignee_type, assignee_id) VALUES (1, 2, 'C', 'user', 1)").run();
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
