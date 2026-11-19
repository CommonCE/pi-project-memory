// Sparse TF-IDF vectors, stored only in memory. No embeddings or network calls.
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', '继续', '项目', '什么']);
function tokens(value) {
  const result = [];
  for (const [word] of value.normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu)) {
    if (/^\p{Script=Han}+$/u.test(word)) {
      for (let i = 0; i < word.length - 1; i++) if (!STOP.has(word.slice(i, i + 2))) result.push(word.slice(i, i + 2));
    } else if (word.length > 1 && !STOP.has(word)) result.push(word);
  }
  return result;
}
function counts(value) {
  const vector = new Map();
  for (const term of tokens(value)) vector.set(term, (vector.get(term) ?? 0) + 1);
  return vector;
}
function normalized(count, idf) {
  const vector = new Map();
  let norm = 0;
  for (const [term, frequency] of count) {
    const weight = (1 + Math.log(frequency)) * (idf.get(term) ?? 0);
    if (weight > 0) { vector.set(term, weight); norm += weight * weight; }
  }
  if (norm > 0) for (const [term, weight] of vector) vector.set(term, weight / Math.sqrt(norm));
  return vector;
}
export function createVectorStore(notes) {
  const documents = notes.map(note => ({ note, counts: counts(`${note.title}\n${note.title}\n${note.title}\n${note.conditions}\n${note.content}`) }));
  const frequency = new Map();
  for (const document of documents) for (const term of document.counts.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const idf = new Map([...frequency].map(([term, count]) => [term, 1 + Math.log((1 + notes.length) / (1 + count))]));
  const vectors = documents.map(document => ({ note: document.note, vector: normalized(document.counts, idf) }));
  return {
    search(query, limit) {
      const vector = normalized(counts(query), idf);
      return vectors.map(({ note, vector: stored }) => ({ ...note,
        score: [...vector].reduce((sum, [term, weight]) => sum + weight * (stored.get(term) ?? 0), 0),
      })).filter(note => note.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
    },
  };
}
