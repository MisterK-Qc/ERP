const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const sent = [];
let app;
let server;
let baseUrl;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archidoc-features-'));
  app = createApp({ dataDir, mailTransport: { sendMail: async (m) => sent.push(m) } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function login(username) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: username }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
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
  return call;
}

function fileForm(fields, content, name, type = 'text/plain') {
  const form = new FormData();
  form.set('file', new Blob([content], { type }), name);
  for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
  return form;
}

// Smallest PDF that pdf.js accepts, containing a single line of text.
function tinyPdf(text) {
  const stream = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`;
  return [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
}

const flush = () => new Promise((r) => setImmediate(r));
const workflowNamed = async (call, name) => (await call('GET', '/api/workflows')).body.find((w) => w.name === name);

test('parallel stage waits for every step before advancing', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const admin = await login('admin');
  const wf = await workflowNamed(alice, 'Revue de contrat');
  assert.deepEqual(wf.steps.map((s) => s.position), [1, 1, 2]);

  sent.length = 0;
  const { body: doc } = await admin('POST', '/api/documents', fileForm({ title: 'Contrat cadre', workflow_id: wf.id }, 'x', 'c.txt'));
  await flush();
  assert.deepEqual(sent.map((m) => m.to).sort(), ['alice@example.com', 'bob@example.com']);
  assert.equal(doc.current_steps.length, 2);
  assert.ok(doc.current_steps.every((s) => s.due_at));

  // Both parallel reviewers see it on their dashboard.
  assert.ok((await alice('GET', '/api/dashboard')).body.assigned.some((d) => d.id === doc.id));
  assert.ok((await bob('GET', '/api/dashboard')).body.assigned.some((d) => d.id === doc.id));

  const afterAlice = (await alice('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).body;
  assert.equal(afterAlice.current_step, 1, 'stage stays open until Finance approves');
  assert.ok(!(await alice('GET', '/api/dashboard')).body.assigned.some((d) => d.id === doc.id));
  assert.equal((await alice('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).status, 403);

  sent.length = 0;
  const afterBob = (await bob('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).body;
  assert.equal(afterBob.current_step, 2);
  await flush();
  assert.deepEqual(sent.map((m) => m.to), ['admin@example.com']);

  const done = (await admin('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).body;
  assert.equal(done.status, 'approved');
  const detail = (await admin('GET', `/api/documents/${doc.id}`)).body;
  assert.deepEqual(detail.workflow.steps.map((s) => [s.status, s.acted_by_name]), [
    ['approved', 'Alice Martin'],
    ['approved', 'Bob Tremblay'],
    ['approved', 'Administrateur'],
  ]);
});

test('rejection notifies the uploader by e-mail', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  const wf = await workflowNamed(bob, 'Approbation de facture');
  const { body: doc } = await bob('POST', '/api/documents', fileForm({ title: 'Facture douteuse', workflow_id: wf.id }, 'x', 'f.txt'));
  sent.length = 0;
  await alice('POST', `/api/documents/${doc.id}/actions`, { action: 'reject', comment: 'Montant faux' });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'bob@example.com');
  assert.match(sent[0].text, /Montant faux/);
  const detail = (await bob('GET', `/api/documents/${doc.id}`)).body;
  assert.equal(detail.workflow.steps[0].status, 'rejected');
});

test('overdue steps get a single reminder', async () => {
  const bob = await login('bob');
  const wf = await workflowNamed(bob, 'Approbation de facture');
  const { body: doc } = await bob('POST', '/api/documents', fileForm({ title: 'Facture en retard', workflow_id: wf.id }, 'x', 'r.txt'));
  app.locals.db.prepare(`UPDATE document_step_status SET due_at = datetime('now', '-1 day') WHERE document_id = ?`).run(doc.id);

  sent.length = 0;
  assert.equal(app.locals.runReminders(), 1);
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Relance/);
  assert.equal(app.locals.runReminders(), 0, 'no second reminder');
  assert.equal((await bob('GET', `/api/documents/${doc.id}`)).body.overdue, true);
});

test('users who opt out or have no address get no e-mail', async () => {
  const alice = await login('alice');
  const bob = await login('bob');
  assert.equal((await alice('PATCH', '/api/me', { email: 'pas-une-adresse' })).status, 400);
  await alice('PATCH', '/api/me', { notify_email: false });
  const wf = await workflowNamed(bob, 'Approbation de facture');
  sent.length = 0;
  await bob('POST', '/api/documents', fileForm({ workflow_id: wf.id }, 'x', 'n.txt'));
  await flush();
  assert.equal(sent.length, 0);
  await alice('PATCH', '/api/me', { notify_email: true });
});

test('search covers extracted PDF content, ignores accents and returns a snippet', async () => {
  const bob = await login('bob');
  const { body: doc } = await bob(
    'POST',
    '/api/documents',
    fileForm({ title: 'Scan reçu' }, tinyPdf('Penalites de retard applicables'), 'scan.pdf', 'application/pdf')
  );
  const hits = (await bob('GET', '/api/documents?q=pénalités')).body;
  assert.deepEqual(hits.map((d) => d.id), [doc.id]);
  assert.match(hits[0].snippet, /\u0002Penalites\u0003/);
  assert.equal((await bob('GET', '/api/documents?q=penal')).body[0].id, doc.id, 'prefix match');
  assert.equal((await bob('GET', '/api/documents?q=recu')).body[0].id, doc.id, 'title without accent');
  assert.equal((await bob('GET', '/api/documents?q=%22%29%28*')).status, 200, 'FTS syntax is escaped');
});

test('new versions replace the content and keep older files downloadable', async () => {
  const bob = await login('bob');
  const alice = await login('alice');
  const { body: doc } = await bob('POST', '/api/documents', fileForm({ title: 'Procédure' }, 'ancienne licorne', 'proc-v1.txt'));

  assert.equal((await alice('POST', `/api/documents/${doc.id}/versions`, fileForm({}, 'x', 'y.txt'))).status, 403);
  const v2 = await bob('POST', `/api/documents/${doc.id}/versions`, fileForm({ comment: 'Mise à jour' }, 'nouvelle girafe', 'proc-v2.txt'));
  assert.equal(v2.status, 201);
  assert.equal(v2.body.current_version, 2);
  assert.equal(v2.body.original_name, 'proc-v2.txt');

  const detail = (await bob('GET', `/api/documents/${doc.id}`)).body;
  assert.deepEqual(detail.versions.map((v) => v.version), [2, 1]);
  assert.equal((await bob('GET', `/api/documents/${doc.id}/file?version=1`)).body, 'ancienne licorne');
  assert.equal((await bob('GET', `/api/documents/${doc.id}/file`)).body, 'nouvelle girafe');
  assert.equal((await bob('GET', '/api/documents?q=girafe')).body.length, 1);
  assert.equal((await bob('GET', '/api/documents?q=licorne')).body.length, 0);
});

test('folder permissions control reading and writing, with inheritance', async () => {
  const admin = await login('admin');
  const alice = await login('alice');
  const bob = await login('bob');
  const folders = (await admin('GET', '/api/folders')).body;
  const rh = folders.find((f) => f.name === 'Ressources humaines');
  const { body: sub } = await admin('POST', '/api/folders', { name: 'Paie', parent_id: rh.id });

  // Bob has no access to RH; Alice can only read it.
  assert.ok(!(await bob('GET', '/api/folders')).body.some((f) => f.id === rh.id));
  assert.equal((await alice('GET', '/api/folders')).body.find((f) => f.id === sub.id).level, 'read');
  assert.equal((await alice('POST', '/api/documents', fileForm({ folder_id: sub.id }, 'x', 'a.txt'))).status, 403);

  const { body: doc } = await admin('POST', '/api/documents', fileForm({ title: 'Salaire confidentiel', folder_id: sub.id }, 'x', 's.txt'));
  assert.equal(doc.folder_path, 'Ressources humaines / Paie');
  assert.equal((await bob('GET', `/api/documents/${doc.id}`)).status, 404);
  assert.equal((await bob('GET', `/api/documents/${doc.id}/file`)).status, 404);
  assert.equal((await bob('GET', '/api/documents?q=salaire')).body.length, 0);
  assert.equal((await alice('GET', '/api/documents?q=salaire')).body.length, 1);
  assert.equal((await alice('GET', `/api/documents/${doc.id}`)).body.can_edit, false);
  assert.equal((await alice('PATCH', `/api/documents/${doc.id}`, { title: 'x' })).status, 403);

  // Filtering by the parent folder includes subfolders.
  assert.equal((await admin('GET', `/api/documents?folder_id=${rh.id}`)).body.length, 1);

  // Granting Bob write access on the subfolder overrides the inherited rules.
  await admin('PUT', `/api/folders/${sub.id}/permissions`, { permissions: [{ subject_type: 'user', subject_id: 3, level: 'write' }] });
  assert.equal((await bob('GET', `/api/documents/${doc.id}`)).status, 200);
  assert.equal((await alice('GET', `/api/documents/${doc.id}`)).status, 404);
  assert.equal((await admin('DELETE', `/api/folders/${sub.id}`)).status, 409);
  assert.equal((await admin('PATCH', `/api/folders/${rh.id}`, { parent_id: sub.id })).status, 400, 'no cycles');
});

test('assignees can read a document even in a folder they cannot see', async () => {
  const admin = await login('admin');
  const bob = await login('bob');
  const rh = (await admin('GET', '/api/folders')).body.find((f) => f.name === 'Ressources humaines');
  const wf = await workflowNamed(admin, 'Approbation de facture');
  const steps = [{ name: 'Contrôle', assignee_type: 'user', assignee_id: 3 }];
  const { body: solo } = await admin('POST', '/api/workflows', { name: 'Contrôle Bob', steps });
  const { body: doc } = await admin('POST', '/api/documents', fileForm({ folder_id: rh.id, workflow_id: solo.id }, 'x', 'b.txt'));
  assert.equal((await bob('GET', `/api/documents/${doc.id}`)).status, 200);
  assert.equal((await bob('POST', `/api/documents/${doc.id}/actions`, { action: 'approve' })).body.status, 'approved');
  assert.equal((await bob('GET', `/api/documents/${doc.id}`)).status, 404, 'access ends with the assignment');
  assert.ok(wf);
});
