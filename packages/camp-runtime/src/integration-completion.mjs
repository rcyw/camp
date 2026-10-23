import { createHash } from 'node:crypto';
import { parseIntegrationInput, serializeIntegrationInput, parseIntegrationReport, parseChangeSet, parseCandidate, CAMP_DAG_INTEGRATION_ALGORITHM } from '../../camp-protocol/src/index.js';

const same = (a, b) => a && b && ['projectId', 'imageId', 'refKind', 'refId', 'rootId'].every(key => a[key] === b[key]);

/** Completion can be rebuilt only from fully persisted, validated facts. The
 * original outbox, when present, is always replayed without recomputation. */
export function integrationCompletion(record) {
  const input = parseIntegrationInput(record.integrationInput);
  const integration = parseIntegrationReport(record.integrationReport);
  if (integration.inputDigest !== createHash('sha256').update(serializeIntegrationInput(input)).digest('hex')) throw new Error('Integration result differs from the frozen input');
  let changeSet;
  if (integration.status === 'merged') {
    parseCandidate(integration.candidate, { projectId: input.base.projectId, imageId: input.base.imageId });
    const goalBaseline = input.algorithm === CAMP_DAG_INTEGRATION_ALGORITHM
      ? parseCandidate(record.integrationGoalBaseline, { projectId: input.base.projectId, imageId: input.base.imageId })
      : input.base;
    changeSet = parseChangeSet(record.integrationChangeSet);
    if (!same(changeSet.base, goalBaseline) || !same(changeSet.target, integration.candidate)) throw new Error('Integration changes must describe the exact Goal baseline and merged candidate');
  } else if (record.integrationChangeSet) throw new Error('An unsuccessful integration cannot publish candidate changes');
  return {
    workerId: record.workerId, epoch: record.epoch, status: 'completed',
    summary: `Trusted integration ${integration.status}; the server determines continuation from the frozen parents.`,
    inputCandidate: input.base, integration,
    ...(integration.status === 'merged' ? { candidate: integration.candidate, changeSet } : {}),
  };
}
