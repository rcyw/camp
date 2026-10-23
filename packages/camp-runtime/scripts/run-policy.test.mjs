import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedRunPolicy, checkedPlan, completionPolicy } from '../src/run-policy.mjs';

const input = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, refKind: 'commit', refId: `12${'c'.repeat(64)}`, commitId: `12${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
const output = { ...input, refId: `12${'e'.repeat(64)}`, commitId: `12${'e'.repeat(64)}`, baseRef: input.refId };
const plan = { revision: 1, summary: 'Ordered work', tasks: [{ key: 'one', title: 'First', description: 'Implement first part', acceptance: 'Correct behavior', verification: 'Run tests' }] };
const claim = kind => ({ id: 'current-run', workflow: 'serial', taskKind: kind, inputCandidate: input, baseRef: input.commitId });

test('explicit input candidate is authoritative even when dependencies contain other artifacts', () => {
  const value = { ...claim('build'), dependencies: [{ artifacts: [{ ...input, commitId: `12${'f'.repeat(64)}` }, output] }] };
  assert.deepEqual(checkedRunPolicy(value, input), input);
  assert.throws(() => checkedRunPolicy({ ...value, inputCandidate: [input, output] }, input), /ambiguous/);
  assert.throws(() => checkedRunPolicy({ ...value, inputCandidates: [input, output] }, input), /ambiguous/);
  assert.throws(() => checkedRunPolicy({ ...value, inputCandidate: undefined }, input), /ambiguous/);
  assert.throws(() => checkedRunPolicy({ ...value, baseRef: 'main' }, input), /differs/);
});
test('only an initial plan may start from an explicitly named baseline without a candidate', () => {
  assert.equal(checkedRunPolicy({ ...claim('plan'), inputCandidate: null, baseRef: 'main' }, input), null);
  assert.throws(() => checkedRunPolicy({ ...claim('build'), inputCandidate: null, baseRef: 'main' }, input), /initial plan/);
  assert.throws(() => checkedRunPolicy({ ...claim('plan'), baseRef: undefined }, input), /explicit/);
});
test('ordered plan requires actionable unique items rather than a prose completion', () => {
  assert.deepEqual(checkedPlan(plan), plan);
  assert.throws(() => checkedPlan(undefined), /structured/);
  assert.throws(() => checkedPlan({ ...plan, tasks: [...plan.tasks, plan.tasks[0]] }), /unique/);
  assert.throws(() => completionPolicy(claim('plan'), {}, input, output), /structured/);
});
test('DAG plan revision is frozen to protocol 5 while old ordered runs preserve revision 1', () => {
  const dag = { ...plan, revision: 2, tasks: plan.tasks.map(item => ({ ...item, dependsOnKeys: [] })) };
  assert.deepEqual(completionPolicy({ ...claim('build'), protocolVersion: 5 }, { plan: dag }, input, output), { status: 'completed' });
  assert.throws(() => completionPolicy({ ...claim('build'), protocolVersion: 5 }, { plan }, input, output), /revision differs/);
  assert.throws(() => completionPolicy({ ...claim('build'), protocolVersion: 4 }, { plan: dag }, input, output), /revision differs/);
});
for (const kind of ['plan', 'review', 'final_review', 'summary', 'clarification']) {
  test(`${kind} cannot include implementation changes in its candidate`, () => {
    assert.throws(() => completionPolicy(claim(kind), { plan, review: { outcome: 'approved', evidence: 'Tests passed' } }, input, { ...output, rootId: 'f'.repeat(64) }), /readonly_workspace_changed/);
  });
}
test('build suspension saves its partial immutable candidate and exact blocking question', () => {
  const changed = { ...output, rootId: 'f'.repeat(64) };
  const question = { id: 'question-one', status: 'pending', activeRunId: 'current-run' };
  assert.deepEqual(completionPolicy(claim('build'), { blockingQuestion: question }, input, changed), { status: 'suspended', questionId: 'question-one' });
  assert.throws(() => completionPolicy(claim('build'), { blockingQuestion: { ...question, activeRunId: 'old-run' } }, input, changed), /active run/);
  assert.throws(() => completionPolicy(claim('build'), { blockingQuestion: { ...question, status: 'answered' } }, input, changed), /active run/);
  assert.throws(() => completionPolicy(claim('clarification'), { blockingQuestion: { id: 'question-one' } }, input, output), /answer or escalate/);
});
test('final acceptance needs a structured review and preserves its precise outcome', () => {
  assert.throws(() => completionPolicy(claim('final_review'), { plan }, input, output), /structured verdict/);
  assert.deepEqual(completionPolicy(claim('final_review'), { plan, review: { outcome: 'changes_requested', evidence: 'An extra case fails' } }, input, output), { status: 'completed', outcome: 'changes_requested' });
});
test('clarification requires a durable answer or escalation rather than merely no blocking question', () => {
  assert.throws(() => completionPolicy(claim('clarification'), {}, input, output), /durably answer/);
  assert.throws(() => completionPolicy(claim('clarification'), { assignedQuestion: { status: 'awaiting_role' } }, input, output), /durably answer/);
  for (const status of ['answered', 'awaiting_human']) assert.deepEqual(completionPolicy(claim('clarification'), { assignedQuestion: { status } }, input, output), { status: 'completed' });
});
test('final planner summary requires the current durable finalization record', () => {
  assert.throws(() => completionPolicy(claim('summary'), { plan }, input, output), /camp_finalize/);
  assert.deepEqual(completionPolicy(claim('summary'), { plan, finalization: { summary: 'Delivered and verified', evidence: null, remaining: [] } }, input, output), { status: 'completed' });
});
