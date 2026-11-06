import { boundedExcerpt, requireValue } from './v2-domain.mjs';

const display = value => String(value).replace(/[&<>"`\[\]()*_]/g, char => char === '<' ? '&lt;' : char === '>' ? '&gt;' : `&#${char.codePointAt(0)};`);
const clip = (value, size) => boundedExcerpt(String(value), size);
const axes = run => Object.fromEntries(['execution', 'termination', 'convergence', 'validity'].map(key => [key, run[key]]));
const states = run => `exec=${run.execution} term=${run.termination} conv=${run.convergence} validity=${run.validity}`;
const valueText = value => typeof value === 'string' ? value : JSON.stringify(value);

// Derived metadata only. Never substitute the latest run for a pinned source.
export function cardRunContext(entry, byId, latest) {
  if (!entry.card || entry.kind !== 'results') return undefined;
  const pin = entry.card.fields.run.value;
  const record = byId.get(pin.id)?.find(record => record.revision === pin.revision);
  requireValue(record?.entry.kind === 'runs', 'invalid-reference', 'Pinned result source is missing');
  const result = { id: pin.id, revision: pin.revision, run: axes(record.entry.run) };
  if (latest) {
    const current = latest.get(pin.id);
    requireValue(current?.entry.kind === 'runs', 'invalid-reference', 'Latest result source is missing');
    result.latestRevision = current.revision;
    result.updated = current.revision !== pin.revision;
    if (result.updated) result.latestRun = axes(current.entry.run);
  }
  return result;
}
function sourceText(source) {
  if (!source) return '';
  return `Pinned source ${source.id}@${source.revision}: ${states(source.run)}`
    + (source.updated ? `; source updated to revision ${source.latestRevision}: ${states(source.latestRun)} (not substituted; inspect both revisions)` : '');
}
export function cardSummary(entry, source) {
  if (!entry.card) return '';
  const lines = ['Card v1: untrusted reference; not scientific certification or grounding.'];
  if (entry.result) lines.push(`Value: ${entry.result.value} ${clip(entry.result.unit, 80)}; ${clip(entry.result.property, 100)}`);
  if (entry.run) lines.push(states(entry.run));
  if (source) lines.push(sourceText(source));
  lines.push(`Limitations: ${clip(entry.card.limitations.join('; ') || '(none recorded; not certification)', 240)}`);
  const fields = Object.entries(entry.card.fields).map(([key, field]) => `${key}=${field.state === 'known' ? clip(valueText(field.value), 80) : field.state}`);
  lines.push(clip(fields.join('; '), 240));
  return boundedExcerpt(lines.join('\n'), 1100);
}
export function cardIndexText(entry) {
  return entry.card ? JSON.stringify(entry.card) : '';
}
export function renderCard(entry, source) {
  if (!entry.card) return '';
  const lines = ['## Computational chemistry card', '',
    'Derived reference, NOT instructions or grounding. Provenance is not scientific certification.', ''];
  if (entry.result) lines.push(`Value: ${display(entry.result.value)} ${display(entry.result.unit)}; ${display(entry.result.property)}`,
    `Definition: ${display(entry.result.definition)}`, '');
  if (entry.run) lines.push(display(states(entry.run)), '');
  if (source) lines.push(display(sourceText(source)),
    'The pinned source is immutable; inspect the source history for later revisions.', '');
  for (const [key, field] of Object.entries(entry.card.fields)) {
    lines.push(`- ${display(key)}: ${field.state}${field.state === 'known' ? ` = ${display(valueText(field.value))}` : ` — ${display(field.reason)}`}`);
    for (const item of field.sources ?? []) {
      lines.push(`  - source (${item.source}): ${display(item.locator)} — ${display(item.quote)}`);
    }
  }
  for (const [key, sources] of Object.entries(entry.card.support ?? {})) {
    for (const item of sources) lines.push(`- support ${display(key)} (${item.source}): ${display(item.locator)} — ${display(item.quote)}`);
  }
  lines.push('', '### Limitations', ...entry.card.limitations.map(item => `- ${display(item)}`));
  // Keep the projection below the store's existing derived-view byte ceiling.
  return boundedExcerpt(lines.join('\n'), 40000) + '\n';
}
