const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

let server;
let baseUrl;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archidoc-test-'));
  server = createApp({ dataDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Minimal client keeping one session cookie per user.
async function login(username) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: username }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, url, body) => {
    const init = { method, headers: { cookie } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${baseUrl}${url}`, init);
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
}

function uploadForm(fields, content = 'contenu de test', name = 'facture-été.txt') {
  const form = new FormData();
  form.set('file', new Blob([content], { type: 'text/plain' }), name);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

test('rejects unauthenticated requests and bad credentials', async () => {
  assert.equal((await fetch(`${baseUrl}/api/dashboard`)).status, 401);
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'nope' }),
  });
  assert.equal(res.status, 401);
});

test('document goes through every workflow step to approval', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const admin = await login('admin');

  const { body: workflows } = await alice('GET', '/api/workflows');
  const wf = workflows.find((w) => w.name === 'Approbation de facture');

  const created = await bob('POST', '/api/documents', uploadForm({ title: 'Facture ACME', tags: 'Facture, ACME', workflow_id: wf.id }));
  assert.equal(created.status, 201);
  const doc = created.body;
  assert.equal(doc.original_name, 'facture-été.txt');
  assert.equal(doc.tags, 'facture, acme');
  assert.equal(doc.status, 'in_progress');
  assert.equal(doc.current_step, 1);

  // Step 1 is assigned to Alice personally.
  assert.ok((await alice('GET', '/api/dashboard')).body.assigned.some((d) => d.id === doc.id));
  assert.ok(!(await bob('GET', '/api/dashboard')).body.assigned.some((d) => d.id === doc.id));
  assert.equal((await bob('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).status, 403);
  assert.equal((await alice('POST', `/api/documents/${doc.id}/actions`, { action: 'approve', comment: 'OK' })).body.current_step, 2);

  // Step 2 is assigned to the Finance group (Bob is a member).
  assert.ok((await bob('GET', '/api/dashboard')).body.assigned.some((d) => d.id === doc.id));
  assert.equal((await bob('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).body.current_step, 3);

  // Step 3 is the Direction group (admin).
  const final = await admin('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' });
  assert.equal(final.body.status, 'approved');

  const detail = await alice('GET', `/api/documents/${doc.id}`);
  assert.deepEqual(
    detail.body.history.map((h) => h.action),
    ['uploaded', 'workflow_started', 'approved_step', 'approved_step', 'approved_step', 'completed']
  );
  assert.equal(detail.body.can_act, false);
});

test('rejection requires a reason and the uploader can restart the workflow', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const { body: [wf] } = await bob('GET', '/api/workflows');
  const { body: doc } = await bob('POST', '/api/documents', uploadForm({ title: 'Contrat', workflow_id: wf.id }));

  assert.equal((await alice('POST', `/api/documents/${doc.id}/actions`, { action: 'reject' })).status, 400);
  const rejected = await alice('POST', `/api/documents/${doc.id}/actions`, { action: 'reject', comment: 'Montant erroné' });
  assert.equal(rejected.body.status, 'rejected');

  const restarted = await bob('POST', `/api/documents/${doc.id}/start`, { workflow_id: wf.id });
  assert.equal(restarted.body.status, 'in_progress');
  assert.equal(restarted.body.current_step, 1);
});

test('search matches every term and filters by status', async () => {
  const bob = await login('bob');
  await bob('POST', '/api/documents', uploadForm({ title: 'Rapport annuel', description: 'Bilan financier 2026' }, 'x', 'rapport.txt'));

  const hits = (await bob('GET', '/api/documents?q=rapport%202026')).body;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].status, 'draft');
  assert.equal((await bob('GET', '/api/documents?q=rapport%20inexistant')).body.length, 0);
  assert.ok((await bob('GET', '/api/documents?status=draft')).body.every((d) => d.status === 'draft'));
  assert.equal((await bob('GET', '/api/documents?q=100%25')).status, 200);
});

test('downloads are forced to attachment for non-previewable types', async () => {
  const bob = await login('bob');
  const form = new FormData();
  form.set('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html');
  const { body: doc } = await bob('POST', '/api/documents', form);
  const res = await fetch(`${baseUrl}/api/documents/${doc.id}/file?inline=1`, {
    headers: { cookie: (await loginCookie('bob')) },
  });
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
});

test('only admins manage workflows, and in-use workflows cannot be edited', async () => {
  const alice = await login('alice');
  const admin = await login('admin');
  const { body: users } = await admin('GET', '/api/users');
  const steps = [{ name: 'Relecture', assignee_type: 'user', assignee_id: users[0].id }];

  assert.equal((await alice('POST', '/api/workflows', { name: 'X', steps })).status, 403);
  assert.equal((await admin('POST', '/api/workflows', { name: 'Vide', steps: [] })).status, 400);
  const created = await admin('POST', '/api/workflows', { name: 'Relecture simple', steps });
  assert.equal(created.status, 201);

  await alice('POST', '/api/documents', uploadForm({ workflow_id: created.body.id }));
  assert.equal((await admin('PUT', `/api/workflows/${created.body.id}`, { name: 'Relecture simple', steps })).status, 409);
});

async function loginCookie(username) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: username }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
