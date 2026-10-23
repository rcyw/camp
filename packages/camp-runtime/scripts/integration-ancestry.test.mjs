import test from 'node:test';
import assert from 'node:assert/strict';
import { proveUniqueMergeBase } from '../src/integration-ancestry.mjs';

const layer = '32' + '0'.repeat(64), id = number => '12' + number.toString(16).padStart(64, '0');
const row = (number, parent = null, secondParent = null, base = layer) => ({ id: id(number), root: number.toString(16).padStart(64, '0'), parent: parent === null ? null : id(parent), secondParent: secondParent === null ? null : id(secondParent), base });
const candidate = value => ({ refId: typeof value === 'number' ? id(value) : value, rootId: typeof value === 'number' ? value.toString(16).padStart(64, '0') : '0'.repeat(64) });
function fixture(records) {
  const nodes = new Map(records.map(record => [record.id, record])), reads = [];
  const readLine = async (ref, { stopAt, stopRefs, limit }) => {
    reads.push({ ref, stopAt }); const result = [], seen = new Set();
    while (ref) {
      const value = nodes.get(ref); if (!value || seen.has(ref) || result.length >= limit) break;
      seen.add(ref); result.push(value);
      if (ref === stopAt || stopRefs.has(ref)) break;
      ref = value.parent;
    }
    return result;
  };
  return { readLine, reads, prove: (base, left, right, options = {}) => proveUniqueMergeBase({ base: candidate(base), parents: [candidate(left), candidate(right)], readLine, ...options }) };
}
test('a shared ancestor inside a goal is the base, including a merge on only one side', async () => {
  const f = fixture([row(1), row(2), row(3, 1, 2), row(4, 3), row(5, 1)]);
  const proof = await f.prove(1, 4, 5);
  assert.equal(proof.mergeBase, id(1)); assert(f.reads.some(read => read.ref === id(2)));
  assert(!f.reads.some(read => read.ref === id(1)), 'The known base need not be opened again when its Layer boundary dominates older history');
  assert(proof.nodes.some(node => node.id === id(3) && node.parents.includes(id(2))));
});
test('a prior merge Commit can be a bounded baseline without traversing its older parents', async () => {
  const f = fixture([row(3, 1, 2), row(4, 3), row(5, 3)]);
  assert.equal((await f.prove(3, 4, 5)).mergeBase, id(3));
  assert.equal(f.reads.some(read => [id(1), id(2), id(3)].includes(read.ref)), false);
});
test('an older common ancestor exposed on a secondary path triggers base expansion rather than a false ambiguity', async () => {
  const f = fixture([row(1), row(2), row(3, 1, 2), row(4, 3, 1), row(5, 3, 1)]);
  assert.equal((await f.prove(3, 4, 5)).mergeBase, id(3));
  assert(f.reads.some(read => read.ref === id(3) && read.stopAt === null));
});
test('criss-cross and a nonmaximal requested base are rejected instead of adopting a native tie-break', async () => {
  const f = fixture([row(1), row(2), row(3, 1, 2), row(4, 2, 1)]);
  await assert.rejects(f.prove(1, 3, 4), { code: 'camp_integration_ancestry_rejected' });
  const g = fixture([row(1), row(2, 1), row(3, 1)]);
  await assert.rejects(g.prove(layer, 2, 3), { code: 'camp_integration_ancestry_rejected' });
});
test('same reference and explicit ancestor inputs are safe while equal roots do not collapse distinct references', async () => {
  const f = fixture([row(1), row(2, 1)]);
  assert.equal((await f.prove(1, 1, 2)).mergeBase, id(1));
  assert.equal((await f.prove(1, 1, 1)).mergeBase, id(1));
  const sameRoot = row(3); sameRoot.root = row(2).root;
  const g = fixture([row(2), sameRoot]);
  const base = candidate(layer), parents = [candidate(2), { refId: id(3), rootId: sameRoot.root }];
  const proof = await proveUniqueMergeBase({ base, parents, readLine: g.readLine });
  assert(proof.nodes.some(node => node.id === id(2))); assert(proof.nodes.some(node => node.id === id(3)));
});
test('the history budget includes Layer nodes and rejects incomplete pages, cycles and inconsistent roots', async () => {
  const f = fixture([row(1), row(2, 1), row(3)]);
  await assert.rejects(f.prove(layer, 2, 3, { limit: 3 }), { code: 'camp_integration_ancestry_rejected' });
  await assert.rejects(fixture([row(2, 1), row(3)]).prove(layer, 2, 3), { code: 'camp_integration_ancestry_rejected' });
  await assert.rejects(fixture([row(1, 2), row(2, 1), row(3)]).prove(layer, 1, 3), { code: 'camp_integration_ancestry_rejected' });
  await assert.rejects(proveUniqueMergeBase({ base: candidate(layer), parents: [{ ...candidate(2), rootId: 'f'.repeat(64) }, candidate(3)], readLine: f.readLine }), { code: 'camp_integration_ancestry_rejected' });
});
test('multiple Layer domains are explicitly unsupported rather than guessing publication ancestry', async () => {
  const f = fixture([row(1), row(2, null, null, '32' + '9'.repeat(64))]);
  await assert.rejects(f.prove(layer, 1, 2), { code: 'camp_integration_ancestry_rejected' });
});
