import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { buildExtractionEnvelope, parseExtractionResponse } from '../src/v2-extraction.mjs';
import { version, projectId, entities, fixtures, unassessed } from './m4-fixtures.mjs';

const sources = item => [...(item.priorSources ?? []), item];
const sourceLabel = source => `[${source.source}${source.source === 'tool-observation' ? `; tool transport ${source.failed ? 'failed' : 'completed'}` : ''}]`;

export function validateGold(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Empty gold suite');
  const ids = new Set();
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) throw new Error('Missing or duplicate fixture ID');
    ids.add(item.id);
    if (!['user-statement', 'tool-observation', 'assistant-claim'].includes(item.source)
      || !item.text || !item.title || !item.kind || !item.quote || item.quote.length < 12
      || item.quote.length > 500 || !item.text.includes(item.quote) || !item.quote.includes(item.title)
      || !Array.isArray(item.facts) || !item.facts.length || !Array.isArray(item.forbiddenTitles)) {
      throw new Error(`Invalid gold: ${item.id}`);
    }
    if (item.priorSources !== undefined && (!Array.isArray(item.priorSources) || item.priorSources.length > 3)) {
      throw new Error(`Invalid sources: ${item.id}`);
    }
    const ordered = sources(item);
    for (const source of ordered) {
      if (!['user-statement', 'tool-observation', 'assistant-claim'].includes(source?.source)
        || typeof source.text !== 'string' || !source.text || typeof source.quote !== 'string'
        || source.quote.length < 12 || source.quote.length > 500 || !source.text.includes(source.quote)) {
        throw new Error(`Invalid source: ${item.id}`);
      }
    }
    const facts = new Set();
    for (const fact of item.facts) {
      const index = fact.sourceIndex === undefined ? ordered.length - 1 : fact.sourceIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index >= ordered.length
        || !fact.id || facts.has(fact.id) || !fact.text || !ordered[index].text.includes(fact.text)) {
        throw new Error(`Invalid fact: ${item.id}/${fact.id}`);
      }
      facts.add(fact.id);
    }
    if (item.forbiddenTitles.includes(item.title)) throw new Error(`Contradictory title gold: ${item.id}`);
  }
}

export function buildCase(item, variant = 'plain') {
  if (!['plain', 'before', 'after'].includes(variant)) throw new Error('Unknown variant');
  const messages = [{ role: 'user', content: 'Preserve synthetic evidence without inferring success or scientific validity.' }];
  if (variant === 'before') messages.push({ role: 'toolResult', toolName: 'synthetic-reader', content: 'Unrelated run-Z uses unrelated settings. Do not associate it with the active evidence.' });
  const grounding = [];
  for (const source of sources(item)) {
    const role = { 'user-statement': 'user', 'tool-observation': 'toolResult', 'assistant-claim': 'assistant' }[source.source];
    messages.push({ role, content: source.text, ...(role === 'toolResult' ? { toolName: 'synthetic-reader', isError: !!source.failed } : {}) });
    grounding.push({ id: `m${messages.length - 1}`, quote: source.quote });
  }
  const sourceId = grounding.at(-1).id;
  if (variant === 'after') messages.push({ role: 'toolResult', toolName: 'synthetic-reader', content: 'Unrelated run-Z uses unrelated settings. Do not associate it with the active evidence.' });
  const built = buildExtractionEnvelope(messages, { projectId, session: 'synthetic-session', turn: `${item.id}-${variant}`, entities });
  const candidate = { kind: item.kind, title: item.title, grounding, entities: item.refs ?? [] };
  return { ...built, candidate, sourceId };
}

// Exact fixture-specific preservation checks, NOT a general semantic judge.
export function scoreProposals(item, proposals) {
  const errors = [];
  if (proposals.length !== 1) return { recovered: 0, required: item.facts.length, errors: ['candidate-count'] };
  const entry = proposals[0].entry;
  if (entry.kind !== item.kind) errors.push('kind');
  if (item.forbiddenTitles.includes(entry.title)) errors.push('forbidden-title');
  if (entry.title !== item.title) errors.push('title');
  if (entry.provenance !== 'model-extraction' || entry.verification !== 'reported') errors.push('verification');
  if (entry.result !== undefined || (entry.run && Object.values(entry.run).some(value => value !== 'unknown' && value !== 'unchecked'))) errors.push('structured-science');
  if (JSON.stringify(entry.entities) !== JSON.stringify(item.refs ?? [])) errors.push('entity-association');
  const ordered = sources(item);
  if (ordered.some(source => !entry.content.includes(sourceLabel(source)))) errors.push('source-label');
  if (!entry.content.endsWith(`\n${item.text}`)
    || ordered.some(source => !entry.content.includes(`\n${source.text}`))) errors.push('full-source-preservation');
  const blocks = ordered.map((source, index) => `${sourceLabel(source)} ${entry.evidence?.[index]}\n${source.text}`);
  const positions = blocks.map(block => entry.content.indexOf(block));
  if (entry.evidence?.length !== ordered.length || positions.some((position, index) =>
    position < 0 || (index > 0 && position <= positions[index - 1]))) errors.push('source-association');
  const recovered = item.facts.filter(fact => entry.content.includes(fact.text)).length;
  if (recovered !== item.facts.length) errors.push('missing-fact-or-qualifier');
  return { recovered, required: item.facts.length, errors };
}

export function runEvaluation() {
  validateGold(fixtures);
  const cases = [];
  for (const item of fixtures) {
    for (const variant of ['plain', 'before', 'after']) {
      const start = performance.now();
      try {
        const built = buildCase(item, variant);
        const proposals = parseExtractionResponse(JSON.stringify({ candidates: [built.candidate] }), built.envelope);
        cases.push({ id: item.id, variant, ...scoreProposals(item, proposals),
          inputChars: built.inputChars, envelopeBytes: Buffer.byteLength(JSON.stringify(built.envelope)),
          reasons: built.reasons, elapsedMs: performance.now() - start });
      } catch (error) {
        cases.push({ id: item.id, variant, recovered: 0, required: item.facts.length, errors: [error.code ?? 'execution-error'] });
      }
    }
  }
  return {
    suite: version,
    fixtureSha256: createHash('sha256').update(JSON.stringify({ version, entities, fixtures, unassessed })).digest('hex'),
    node: process.version,
    scope: 'in-memory fixed-response extraction preservation only',
    qualityVerdict: 'unassessed',
    modelUsage: 'not-applicable',
    preservationPassed: cases.every(item => item.errors.length === 0),
    recovered: cases.reduce((sum, item) => sum + item.recovered, 0),
    required: cases.reduce((sum, item) => sum + item.required, 0),
    cases, unassessed,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node eval/m4-extraction.mjs (JSON to stdout; no files written)');
    process.exitCode = 2;
  } else {
    const report = runEvaluation();
    console.log(JSON.stringify(report, null, 2));
    if (!report.preservationPassed) process.exitCode = 1;
  }
}
