import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { candidateIdentity, selectCapturedDelivery } from './capture-delivery.mjs';

/** Inspect real server projections only. The caller blocks all Camp mutations. */
export async function captureDagRoom({ page, panel, card, snapshot, goal, record, folder, readCamp }) {
  assert.equal(goal.plan?.revision, 2); assert.ok(goal.items.length > 0 && goal.items.length <= 6);
  const graph = card.getByTestId('camp-dependency-graph'); await graph.waitFor();
  assert.equal(await graph.locator('[data-testid^=camp-plan-item-]').count(), goal.items.length);
  for (const item of goal.items) {
    const node = card.getByTestId('camp-plan-item-' + item.key), input = node.getByTestId('camp-node-input');
    await input.waitFor(); assert.ok((await node.locator('header').innerText()).includes(item.title));
    assert.equal(await input.locator('ul').first().getByRole('link').count(), item.dependsOnKeys.length);
    if (item.inputSources.length) {
      const sources = input.getByTestId('camp-node-sources'); await sources.locator('summary').click();
      assert.equal(await sources.locator('[data-source-key]').count(), item.inputSources.length);
      for (const source of item.inputSources) {
        const pinned = sources.locator(`[data-source-key="${source.key}"]`);
        assert.ok((await pinned.innerText()).includes(source.runId)); assert.ok((await pinned.innerText()).includes(source.candidate.refId));
      }
      await sources.locator('summary').click();
    }
    if (item.inputCandidate) assert.ok((await input.getByTestId('camp-node-effective-input').innerText()).includes(item.inputCandidate.refId));
    const blocked = item.scheduling?.blockedByKeys ?? [];
    assert.equal(await input.getByTestId('camp-node-blockers').getByRole('link').count(), blocked.length);
  }
  await graph.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, record.kind + '-graph.png'), fullPage: true });
  const operations = goal.integration?.operations ?? [];
  for (const [index, operation] of operations.entries()) {
    assert.equal(operation.goalAttempt, goal.attempt);
    const owner = operation.scope === 'node_input' ? card.getByTestId('camp-plan-item-' + operation.planItemKey) : card.getByTestId('camp-goal-integration');
    const view = owner.locator(`[data-testid=camp-integration-operation][data-operation-id="${operation.id}"]`);
    await view.waitFor(); assert.equal(await view.getAttribute('data-scope'), operation.scope ?? 'goal');
    const inputs = view.getByTestId('camp-integration-inputs'); await inputs.locator('summary').click();
    assert.ok((await inputs.getByTestId('camp-integration-base').innerText()).includes(operation.integrationInput.base.refId));
    const parents = inputs.getByTestId('camp-integration-parent'); assert.equal(await parents.count(), 2);
    for (const [parentIndex, parent] of operation.integrationInput.parents.entries()) {
      assert.equal(await parents.nth(parentIndex).getAttribute('data-parent-key'), parent.key);
      assert.ok((await parents.nth(parentIndex).innerText()).includes(parent.candidate.refId));
    }
    const receipt = operation.integrationReport;
    if (receipt) {
      assert.equal(receipt.operationId, operation.id); assert.equal(receipt.runId, operation.latestRunId); assert.equal(receipt.inputDigest, operation.inputDigest);
      const visible = view.getByTestId('camp-integration-receipt'); await visible.waitFor();
      assert.equal(await visible.getAttribute('data-status'), receipt.status); assert.equal(await visible.getAttribute('data-input-digest'), receipt.inputDigest);
      if (receipt.candidate) assert.equal(await visible.getAttribute('data-candidate-ref'), receipt.candidate.refId);
    }
    await view.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, `${record.kind}-integration-${index + 1}.png`), fullPage: true });
    await inputs.locator('summary').click();
  }
  const deliveryView = card.getByTestId('camp-graph-delivery'); await deliveryView.waitFor();
  assert.equal(await deliveryView.getAttribute('data-status'), goal.graph.delivery.status);
  if (goal.graph.delivery.candidate) assert.ok((await deliveryView.innerText()).includes(goal.graph.delivery.candidate.refId));
  let delivery = null;
  if (goal.resultReady) {
    const prefix = `/rooms/${record.roomId}/goals/${record.goalId}`;
    const manifest = await readCamp(prefix + '/result'), versions = await readCamp(prefix + '/versions');
    delivery = selectCapturedDelivery({ goal, manifest, versions: versions.versions, acceptedHead: snapshot.room.acceptedHead });
    const version = delivery.version, changes = await readCamp(`${prefix}/versions/${version.runId}/changes`), verification = await readCamp(`${prefix}/versions/${version.runId}/verification`);
    assert.equal(changes.available, true); assert.equal(candidateIdentity(changes.changeSet.target), candidateIdentity(delivery.candidate));
    assert.equal(verification.status, 'passed'); assert.equal(verification.receipt?.status, 'passed');
    assert.equal(candidateIdentity(verification.receipt.candidate), candidateIdentity(delivery.candidate)); assert.equal(verification.receipt.policyDigest, goal.verificationPolicy.digest);
    const history = card.getByTestId('camp-versions-' + goal.id); await history.locator('summary').click();
    await history.getByTestId('camp-version-select').selectOption(version.id);
    await history.locator(`[data-testid=camp-verification-report][data-candidate-ref="${delivery.candidate.refId}"][data-status=passed]`).waitFor();
    assert.deepEqual(await history.getByTestId('camp-change-entry').evaluateAll(elements => elements.map(element => element.getAttribute('data-path'))), changes.changeSet.entries.map(entry => entry.path));
    assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 1);
    await history.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, record.kind + '-delivery.png'), fullPage: true });
  } else assert.equal(await card.getByRole('button', { name: 'Download result manifest', exact: true }).count(), 0);
  if (!goal.canRetry) assert.equal(await card.getByRole('button', { name: 'Retry goal', exact: true }).count(), 0);
  if (goal.integrationInspectionRequired || goal.reason === 'integration_inspection_required') await card.getByText(/no action to confirm that inspection and resume this goal/).waitFor();
  assert.equal(await panel.getByTestId('camp-room-error').count(), 0);
  return { kind: record.kind, planMode: goal.planMode, roomId: record.roomId, goalId: record.goalId, resultReady: goal.resultReady, goalStatus: goal.status, goalReason: goal.reason, canRetry: goal.canRetry, graph: goal.graph, nodeCount: goal.items.length, scopedIntegrationCount: operations.filter(value => value.scope === 'node_input').length, goalIntegrationCount: operations.filter(value => value.scope !== 'node_input').length, deliveredCandidate: delivery?.candidate ?? null, deliveredProducerRunId: delivery?.version.runId ?? null };
}
