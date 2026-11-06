import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeV2, resolveV2, saveV2, searchV2, getV2 } from '../src/v2-store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['calc/neb', 'calc/opt']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const project = initializeV2(root);
  const save = (title, folder, inherit = true) => saveV2(project, { kind: 'methods', title,
    content: 'shared method evidence', ...(folder === undefined ? {} : { scope: { path: folder, inherit } }) }).record;
  return { root, project, save };
}

test('T3 ancestors, siblings, inheritance, legacy root, ranking and annotations', t => {
  const { root, project, save } = fixture(t);
  const legacy = save('legacy', undefined), parent = save('parent', 'calc'), local = save('local', 'calc/neb');
  const hidden = save('private', 'calc', false), sibling = save('sibling', 'calc/opt');
  const current = resolveV2(path.join(root, 'calc/neb'));
  const hits = searchV2(current, 'shared').hits;
  assert.deepEqual(hits.map(h => h.id), [local.id, parent.id, legacy.id]);
  assert.deepEqual(hits.map(h => h.scopeRank), [2, 1, 0]);
  assert.deepEqual(hits.at(-1).scope, { path: '.', inherit: true });
  assert.equal(getV2(project, legacy.id).entry.scope, undefined);
  assert.deepEqual(searchV2(project, 'shared').hits.map(h => h.id), [legacy.id]);
  assert.equal(searchV2(current, 'shared', { allFolders: true }).hits.length, 5);
  assert.equal(searchV2(current, 'shared', { entityId: sibling.id }).hits[0].scopeRank, -1);
  assert.equal(searchV2(current, 'shared', { entityIds: [sibling.id] }).hits[0].id, sibling.id);
  assert(searchV2(current, 'shared', { folder: 'calc' }).hits.some(h => h.id === hidden.id));
  assert.throws(() => searchV2(current, 'shared', { folder: '../escape' }), { code: 'invalid-schema' });
  assert.throws(() => searchV2(current, 'shared', { allFolders: 'yes' }), { code: 'invalid-schema' });
});

test('T3 document frequencies exclude siblings and explicit historical folders need not exist', t => {
  const { project, save } = fixture(t);
  save('parent', '.'); save('local', 'gone/child');
  const opts = { folder: 'gone/child' };
  const before = searchV2(project, 'shared', opts).hits.map(h => [h.id, h.score]);
  save('irrelevant sibling', 'calc/opt');
  assert.deepEqual(searchV2(project, 'shared', opts).hits.map(h => [h.id, h.score]), before);
});
