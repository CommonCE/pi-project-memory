import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('T9 M5 docs describe implemented local scope contracts without claiming live scientific validation', () => {
  const design = read('docs/next/m5-folder-scope.md');
  assert.match(design, /状态：已实现（本地隔离验收）/);
  assert.match(design, /缺失 `inherit` 时保留 `path`/);
  assert.match(read('README.md'), /pi-project-memory v2 folder rebuild/);
  assert.match(read('docs/testing.md'), /## M5：文件夹作用域与首轮简报/);
  assert.match(read('docs/decisions/0006-folder-scoped-memory.md'), /根内符号链接/);
});
