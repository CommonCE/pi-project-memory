import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox } from '../eval/m4-integration.mjs';
import { saveV2, getV2, searchV2 } from '../src/v2-store.mjs';
import { buildWorkingContext, updateWorkingV2 } from '../src/v2-working.mjs';

const ref = (type, record) => ({ type, id: record.id });
const contains = (context, record) => context.paths.some(label => label.includes(`/${record.id}.md`));
function setup(project, { currentRunOnly = false } = {}) {
  const system = saveV2(project, { kind: 'systems', title: 'Same-name system', content: 'scopeprobe Shared system background.' }).record;
  const method = saveV2(project, { kind: 'methods', title: 'Shared method', content: 'scopeprobe Shared method background.' }).record;
  const shared = [ref('system', system), ref('method', method)];
  const runs = ['A', 'B'].map(label => saveV2(project, { kind: 'runs', title: 'Same-name run',
    content: `scopeprobe Identity only ${label}.`, entities: shared }).record);
  const diagnostics = runs.map((run, index) => saveV2(project, { kind: 'diagnostics', title: 'Same-name diagnostic',
    content: `scopeprobe Report for run ${index}; synthetic only, not scientifically verified.`,
    entities: [...(currentRunOnly && index === 1 ? [] : shared), ref('run', run)] }).record);
  return { system, method, shared, runs, diagnostics };
}
function activate(project, entities) {
  updateWorkingV2(project, 'state', 0, { goal: 'Continue scopeprobe inspection', entities: entities.map(record => record.id) });
}

test('mixed system/method/run state keeps active knowledge and shared background, not sibling runs', async () => {
  await withSandbox(({ project }) => {
    const h = setup(project);
    activate(project, [h.system, h.method, h.runs[1]]);
    const context = buildWorkingContext(project, '继续');
    for (const record of [h.runs[1], h.diagnostics[1], h.system, h.method]) assert.ok(contains(context, record));
    for (const record of [h.runs[0], h.diagnostics[0]]) assert.equal(contains(context, record), false);
    assert.deepEqual(getV2(project, h.diagnostics[0].id), h.diagnostics[0]);
    // Explicit search remains broad: only working-context assembly narrows it.
    const broad = searchV2(project, 'scopeprobe', { entityIds: [h.system.id, h.runs[1].id] });
    assert.ok(broad.hits.some(hit => hit.id === h.diagnostics[0].id));
    for (const maxChars of [1000, 3000, 12000]) {
      const bounded = buildWorkingContext(project, '继续', { maxChars });
      assert.ok(bounded.chars <= maxChars);
      assert.equal(bounded.chars, bounded.content.length);
      for (const line of bounded.content.split('\n').filter(line => line.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

test('run record identity and result.runId override contradictory ancillary references', async () => {
  await withSandbox(({ project, root }) => {
    const h = setup(project), current = ref('run', h.runs[1]);
    const foreignRun = saveV2(project, { kind: 'runs', title: 'Foreign run linked to current',
      content: 'scopeprobe Not the current run.', entities: [...h.shared, current] }).record;
    const result = (run, ancillary) => {
      const evidence = `synthetic-${run.id}.log`;
      fs.writeFileSync(path.join(root, evidence), 'Synthetic reported energy 0 Ha; scientific validity unchecked.\n');
      return saveV2(project, { kind: 'results', title: 'Synthetic zero', evidence: [evidence],
        content: 'scopeprobe Reported zero; validity unchecked.', entities: [...h.shared, ancillary],
        result: { runId: run.id, property: 'energy', value: 0, unit: 'Ha', definition: 'Synthetic reported energy; not a validated result.' } }).record;
    };
    const foreignResult = result(h.runs[0], current);
    const currentResult = result(h.runs[1], ref('run', h.runs[0]));
    activate(project, [h.system, h.method, h.runs[1]]);
    const context = buildWorkingContext(project, '继续');
    assert.equal(contains(context, foreignRun), false);
    assert.equal(contains(context, foreignResult), false);
    assert.ok(contains(context, currentResult));
    const hit = context.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(hit => hit.id === currentResult.id);
    assert.equal(hit.result.value, 0);
    assert.equal(hit.result.unit, 'Ha');
    assert.equal(hit.resultRun.convergence, 'unknown');
    assert.equal(hit.resultRun.validity, 'unchecked');
  });
});

test('same-name systems and runs do not replace explicit identity scope', async () => {
  await withSandbox(({ project }) => {
    const h = setup(project);
    const otherSystem = saveV2(project, { kind: 'systems', title: h.system.entry.title, content: 'scopeprobe Separate identity.' }).record;
    const otherRun = saveV2(project, { kind: 'runs', title: h.runs[1].entry.title,
      content: 'scopeprobe Foreign run.', entities: [ref('system', otherSystem)] }).record;
    const foreign = saveV2(project, { kind: 'diagnostics', title: h.diagnostics[1].entry.title,
      content: 'scopeprobe Foreign diagnostic.', entities: [ref('system', otherSystem), ref('run', otherRun)] }).record;
    activate(project, [h.system, h.runs[1]]);
    const context = buildWorkingContext(project, 'scopeprobe');
    assert.ok(contains(context, h.diagnostics[1]));
    for (const record of [otherSystem, otherRun, foreign]) assert.equal(contains(context, record), false);
  });
});

test('system-only scope stays broad and explicitly selecting both runs keeps both', async () => {
  for (const both of [false, true]) await withSandbox(({ project }) => {
    const h = setup(project);
    activate(project, [h.system, h.method, ...(both ? h.runs : [])]);
    const context = buildWorkingContext(project, '继续');
    for (const diagnostic of h.diagnostics) assert.ok(contains(context, diagnostic));
  });
});

test('active-run ranking prevents broad top-eight crowding from hiding a weakly linked current diagnostic', async () => {
  await withSandbox(({ project }) => {
    const h = setup(project, { currentRunOnly: true });
    const siblings = Array.from({ length: 16 }, (_, index) => saveV2(project, { kind: 'diagnostics', title: `Sibling ${index}`,
      content: 'scopeprobe Sibling history only.', entities: [...h.shared, ref('run', h.runs[0])] }).record);
    activate(project, [h.system, h.method, h.runs[1]]);
    const broad = searchV2(project, 'scopeprobe', { entityIds: [h.system.id, h.method.id, h.runs[1].id] });
    assert.equal(broad.hits.some(hit => hit.id === h.diagnostics[1].id), false);
    const context = buildWorkingContext(project, '继续');
    assert.ok(contains(context, h.diagnostics[1]));
    for (const sibling of siblings) assert.equal(contains(context, sibling), false);
  });
});

test('explicit cross-run diagnostic remains eligible when it references the selected run', async () => {
  await withSandbox(({ project }) => {
    const h = setup(project);
    const comparison = saveV2(project, { kind: 'diagnostics', title: 'Cross-run comparison',
      content: 'scopeprobe Compare two explicitly attributed reports; no result certification.', entities: h.runs.map(run => ref('run', run)) }).record;
    activate(project, [h.system, h.runs[1]]);
    assert.ok(contains(buildWorkingContext(project, '继续'), comparison));
  });
});
