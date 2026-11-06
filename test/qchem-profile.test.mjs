import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveConfig, initialize, loadConfig, memoryStats, readProjectConfig, resolveProject, saveNote, search } from '../src/core.mjs';
import { collectEvidence, enqueueCandidate } from '../src/learning.mjs';

function fixture(t, global = {}, local = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-qchem-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'global.json'); fs.writeFileSync(file, JSON.stringify(global));
  const cfg = loadConfig({ home: dir, env: { PI_PROJECT_MEMORY_CONFIG: file } });
  const root = path.join(dir, 'project'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  fs.mkdirSync(path.join(root, '.pi')); fs.writeFileSync(path.join(root, '.pi/project-memory.json'), JSON.stringify(local));
  const project = resolveProject(root, cfg); initialize(project, cfg);
  return { root, project, cfg, effective: effectiveConfig(cfg, project), file };
}
test('qchem project profile increases bounded capacity but preserves suggest and default projects', t => {
  const h = fixture(t, {}, { profile: 'qchem' });
  assert.equal(h.cfg.maxItems, 4); assert.equal(h.effective.maxItems, 8);
  assert.equal(h.effective.learningToolChars, 8000); assert.equal(h.effective.learningMaxCandidates, 8);
  assert.equal(h.effective.learningOutputTokens, 6000); assert.equal(h.effective.learningMode, 'suggest');
  assert.equal(h.effective.contextChars, 16000); assert.equal(h.effective.learningInputChars, 48000);
  assert.equal(h.effective.vaultPath, h.cfg.vaultPath);
});
test('explicit local numbers override global numbers which override profile defaults', t => {
  const h = fixture(t, { maxItems: 6, learningOutputTokens: 4000 }, { profile: 'qchem', maxItems: 10 });
  assert.equal(h.effective.maxItems, 10); assert.equal(h.effective.learningOutputTokens, 4000);
  const globalProfile = loadConfig({ home: h.root, env: { PI_PROJECT_MEMORY_CONFIG: h.file } });
  assert.equal(effectiveConfig(globalProfile, { settings: { profile: 'default' } }).learningToolChars, 2000);
  fs.writeFileSync(h.file, JSON.stringify({ profile: 'qchem' }));
  const qchem = loadConfig({ home: h.root, env: { PI_PROJECT_MEMORY_CONFIG: h.file } });
  assert.equal(qchem.maxItems, 8);
  assert.equal(effectiveConfig(qchem, { settings: { profile: 'default' } }).maxItems, 4);
});
test('invalid tuning is rejected in both global and project config', t => {
  const h = fixture(t);
  for (const settings of [{ profile: 'unknown' }, { learningToolChars: 16001 }, { learningOutputTokens: 999 }, { maxItems: 21 }, { learningMaxCandidates: 2.5 }]) {
    fs.writeFileSync(h.file, JSON.stringify(settings));
    assert.throws(() => loadConfig({ env: { PI_PROJECT_MEMORY_CONFIG: h.file } }));
    const local = path.join(h.root, '.pi/project-memory.json'); fs.writeFileSync(local, JSON.stringify(settings));
    assert.throws(() => readProjectConfig(local));
  }
});
test('manual project selection uses target tuning, not current project tuning', t => {
  const h = fixture(t, {}, { profile: 'qchem' });
  const root = path.join(path.dirname(h.root), 'other'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const other = resolveProject(root, h.cfg); initialize(other, h.cfg);
  const selected = resolveProject(h.root, h.cfg, other.id);
  assert.equal(effectiveConfig(h.cfg, selected).profile, 'default');
});
test('qchem aliases and tags improve recall without admitting pending, inactive or handoff notes', t => {
  const h = fixture(t, {}, { profile: 'qchem' });
  saveNote(h.project, { type: 'observation', title: 'System A', content: 'Bader basin integration of System A.', tags: ['cp2k'] });
  saveNote(h.project, { type: 'observation', title: 'Not checked', content: 'Bader unverified', status: 'unverified' });
  saveNote(h.project, { type: 'session', title: 'Snapshot', content: 'Bader handoff', handoff: true });
  enqueueCandidate(h.project, { type: 'observation', title: 'Pending', content: 'Bader pending result' }, h.effective);
  assert.equal(search(h.project, '盆积分', h.cfg).hits.length, 0);
  assert.equal(search(h.project, '盆积分', h.effective).hits.length, 1);
  assert.equal(search(h.project, 'CP2K', h.effective).hits.length, 1);
  assert.equal(search(h.project, '盆积分', h.effective, 10, undefined, { includeInactive: true, includeHandoffs: true }).hits.length, 3);
});
test('inventory reports scientific status, excludes manifest and remains bounded and marker-gated', t => {
  const h = fixture(t);
  const old = saveNote(h.project, { type: 'decision', title: 'Old', content: 'Old method' });
  saveNote(h.project, { type: 'decision', title: 'New', content: 'New method', supersedes: old.relativePath });
  saveNote(h.project, { type: 'observation', title: 'Unchecked', content: 'Needs checking', status: 'unverified' });
  saveNote(h.project, { type: 'session', title: 'Handoff', content: 'Snapshot', handoff: true });
  const stats = memoryStats(h.project, h.effective);
  assert.equal(stats.total, 4); assert.equal(stats.searchable, 1); assert.equal(stats.unverified, 1);
  assert.equal(stats.superseded, 1); assert.equal(stats.handoffs, 1);
  assert.equal(memoryStats(h.project, { ...h.effective, maxFiles: 1 }).truncated, true);
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  assert.equal(memoryStats(h.project, h.effective).total, 0);
});
test('larger tool evidence retains middle chemistry output and reserves latest user constraints', () => {
  const output = 'a'.repeat(2200) + '\nSCF converged; energy -10.25 Hartree\n' + 'b'.repeat(2200);
  const messages = [{ role: 'user', content: 'System A; charge zero; multiplicity one.' },
    { role: 'toolResult', toolName: 'codemode', content: output },
    { role: 'assistant', content: 'Checked the output for System A.' }];
  assert.ok(!collectEvidence(messages, 10000, { latestTurn: true })[1].text.includes('SCF converged'));
  const expanded = collectEvidence(messages, 10000, { latestTurn: true, toolChars: 8000 });
  assert.ok(expanded[1].text.includes('SCF converged'));
  const bounded = collectEvidence(messages, 1000, { latestTurn: true, toolChars: 8000 });
  assert.equal(bounded[0].id, 'm0');
  assert.ok(bounded.reduce((n, item) => n + item.text.length, 0) < 1000);
  messages[1].content = output + '\napi_key: doNotStoreThisSecret';
  assert.ok(!collectEvidence(messages, 10000, { latestTurn: true, toolChars: 8000 }).some(item => item.role === 'toolResult'));
});
