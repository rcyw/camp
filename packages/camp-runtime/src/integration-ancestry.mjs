const commit = /^12[a-f0-9]{64}$/, layer = /^32[a-f0-9]{64}$/, root = /^[a-f0-9]{64}$/;
const invalid = () => Object.assign(new Error('Integration ancestry is unsupported, incomplete or ambiguous'), { code: 'camp_integration_ancestry_rejected' });

/** Prove the actual binary history, not logical task order or equal trees.
 * A sole Layer boundary dominates its older history; multiple Layer domains
 * require a Layer-ancestry API and are deliberately unsupported here. */
export async function proveUniqueMergeBase({ base, parents, readLine, limit = 4096, signal }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096 || parents.length !== 2) throw invalid();
  const nodes = new Map(), expected = new Map(), layers = new Set();
  for (const candidate of [base, ...parents]) {
    if (expected.has(candidate.refId) && expected.get(candidate.refId) !== candidate.rootId) throw invalid();
    expected.set(candidate.refId, candidate.rootId);
  }
  const addLayer = id => {
    if (!layer.test(id)) throw invalid();
    layers.add(id); if (layers.size > 1) throw invalid();
    if (!nodes.has(id)) nodes.set(id, { id, parents: [], cut: false });
    if (nodes.size > limit) throw invalid();
  };
  async function walk(starts, cutBase) {
    const queue = [...starts];
    while (queue.length) {
      signal?.throwIfAborted();
      const start = queue.pop();
      if (layer.test(start)) { addLayer(start); continue; }
      if (!commit.test(start)) throw invalid();
      const known = nodes.get(start);
      if (known && (!known.cut || cutBase)) continue;
      const stopRefs = new Set([...nodes].filter(([, node]) => !node.cut).map(([id]) => id));
      const rows = await readLine(start, { stopAt: cutBase ? base.refId : null, stopRefs, limit, signal });
      if (!Array.isArray(rows) || !rows.length || rows.length > limit) throw invalid();
      let next = start, stopped = false;
      const seen = new Set();
      for (const value of rows) {
        if (stopped || value.id !== next || !commit.test(value.id ?? '') || !root.test(value.root ?? '') || !(value.parent === null || commit.test(value.parent ?? '')) || !(value.secondParent === null || commit.test(value.secondParent ?? '') || layer.test(value.secondParent ?? '')) || !layer.test(value.base ?? '') || seen.has(value.id)) throw invalid();
        seen.add(value.id);
        if (expected.has(value.id) && expected.get(value.id) !== value.root) throw invalid();
        const facts = { id: value.id, root: value.root, parent: value.parent, secondParent: value.secondParent, base: value.base };
        const previous = nodes.get(value.id);
        if (previous?.facts && JSON.stringify(previous.facts) !== JSON.stringify(facts)) throw invalid();
        const cut = cutBase && value.id === base.refId;
        const edges = cut ? [value.base] : [...new Set([value.parent, value.secondParent, value.base].filter(Boolean))];
        nodes.set(value.id, { id: value.id, facts, parents: edges, cut });
        if (nodes.size > limit) throw invalid();
        for (const edge of edges) if (edge !== value.parent) queue.push(edge);
        next = value.parent;
        stopped = cut || next === null || previous && !previous.cut;
      }
      if (!stopped) {
        if (nodes.has(next) && !nodes.get(next).cut) continue;
        throw invalid();
      }
    }
  }
  function ancestors(start) {
    const result = new Set(), visiting = new Set(), stack = [[start, false]];
    while (stack.length) {
      const [id, done] = stack.pop();
      if (done) { visiting.delete(id); result.add(id); continue; }
      if (result.has(id)) continue;
      if (visiting.has(id) || !nodes.has(id)) throw invalid();
      visiting.add(id); stack.push([id, true]);
      for (const parent of nodes.get(id).parents) stack.push([parent, false]);
    }
    return result;
  }
  function maximalCommon() {
    const left = ancestors(parents[0].refId), right = ancestors(parents[1].refId);
    const common = new Set([...left].filter(id => right.has(id))), dominated = new Set();
    if (!common.has(base.refId)) throw invalid();
    for (const id of common) for (const parent of nodes.get(id).parents) if (common.has(parent)) dominated.add(parent);
    return [...common].filter(id => !dominated.has(id));
  }
  await walk(parents.map(candidate => candidate.refId), true);
  let maxima = maximalCommon();
  // A second route can expose an older ancestor which the base cutoff hid.
  // Expand the base only in that case; never mistake it for a criss-cross.
  if (maxima.length > 1 && maxima.includes(base.refId) && nodes.get(base.refId)?.cut) {
    await walk([base.refId], false); maxima = maximalCommon();
  }
  if (maxima.length !== 1 || maxima[0] !== base.refId) throw invalid();
  return { nodes: [...nodes].sort(([a], [b]) => a.localeCompare(b)).map(([id, node]) => ({ id, ...(node.facts ? { facts: node.facts } : {}), parents: [...node.parents].sort(), cut: node.cut })), mergeBase: base.refId };
}
