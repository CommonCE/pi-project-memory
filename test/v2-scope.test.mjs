import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../src/v2-domain.mjs';
import * as store from '../src/v2-store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('T1 scope defaults and legacy entries remain root-scoped without rewriting', () => {
  assert.equal(domain.SCHEMA_VERSION, 2);
  assert.deepEqual(domain.normalizeScope(undefined), { path: '.', inherit: true });
  assert.deepEqual(domain.normalizeScope({ path: 'calc' }), { path: 'calc', inherit: true });
  const old = domain.normalizeEntry({ kind: 'methods', title: 'Method', content: 'Recorded method' });
  assert.deepEqual(domain.normalizeScope(old.scope), { path: '.', inherit: true });
  assert.equal(Object.hasOwn(old, 'scope'), false);
  assert.deepEqual(domain.normalizeEntry({ ...old, scope: { path: '01 opt/水 (test)', inherit: false } }).scope,
    { path: '01 opt/水 (test)', inherit: false });
});

test('T2 real paths, segment ancestors, session cwd and symlink containment', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-scope-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  const child = path.join(root, '01 opt', '水');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(temp, 'project-other'));
  const project = { root, cwd: child };
  assert.deepEqual(store.scopeFor(project), { path: '01 opt/水', chain: ['.', '01 opt', '01 opt/水'] });
  assert.deepEqual(store.scopeFor(project, root), { path: '.', chain: ['.'] });
  fs.symlinkSync(child, path.join(root, 'alias'));
  assert.equal(store.scopeFor(project, path.join(root, 'alias')).path, '01 opt/水');
  fs.symlinkSync(temp, path.join(root, 'escape'));
  for (const cwd of [temp, path.join(temp, 'project-other'), path.join(root, 'escape')]) {
    assert.throws(() => store.scopeFor(project, cwd), { code: 'scope-outside' });
  }
  assert.throws(() => store.scopeFor(project, path.join(root, 'missing')), { code: 'invalid-scope' });
  fs.writeFileSync(path.join(root, 'file'), 'not a directory');
  assert.throws(() => store.scopeFor(project, path.join(root, 'file')), { code: 'invalid-scope' });
});

test('T1 scope validation preserves real spelling and rejects malformed paths', () => {
  for (const path of ['.', '01 opt/水 (test)', 'a.b/a-b_a', 'e\u0301', 'a'.repeat(400), Array(32).fill('a').join('/')]) {
    assert.deepEqual(domain.normalizeScope({ path }), { path, inherit: true });
  }
  for (const value of [null, [], new Date(), Object.create({ path: 'a' }), {}, { path: '' },
    ...['/tmp', 'C:/tmp', 'a\\b', 'a\0b', 'a\nb', 'a\u0085b', 'a//b', './a', 'a/..', 'a/.', 'a/', ' a', 'a ', 'a/ b', 'a'.repeat(401), Array(33).fill('a').join('/'), '\ud800'].map(path => ({ path })),
    { path: '.', inherit: null }, { path: '.', inherit: 'true' }, { path: '.', extra: true }]) {
    assert.throws(() => domain.normalizeScope(value), { code: 'invalid-schema' });
  }
});
