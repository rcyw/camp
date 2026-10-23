import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const seed = JSON.parse(await readFile(resolve('.dev-env-camp.json'), 'utf8'));
const receipt = JSON.parse(await readFile(resolve('.camp/mvp-receipt.json'), 'utf8'));
const login = await fetch(`${receipt.apiUrl}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: seed.user.email, password: seed.user.password }),
});
if (!login.ok) throw new Error(`Login failed: HTTP ${login.status}`);
const { accessToken } = await login.json();
const response = await fetch(`${receipt.apiUrl}/api/camp/rooms/${receipt.roomId}`, {
  headers: { authorization: `Bearer ${accessToken}`, 'x-server-id': seed.server.id },
});
if (!response.ok) throw new Error(`Snapshot failed: HTTP ${response.status}`);
const state = await response.json();
let channelMessageCounts;
if (process.argv.includes('--assert-completed')) {
  const worker = parseEnv(await readFile(resolve('.camp/mvp-worker.env'), 'utf8'));
  const messagesResponse = await fetch(`${receipt.apiUrl}/api/camp/worker/rooms/${receipt.roomId}/messages`, {
    headers: { authorization: `Bearer ${worker.CAMP_WORKER_TOKEN}` },
  });
  if (!messagesResponse.ok) throw new Error(`Channel verification failed: HTTP ${messagesResponse.status}`);
  const { messages } = await messagesResponse.json();
  channelMessageCounts = Object.fromEntries(state.room.roles.map(role => [role.role, messages.filter(message => message.senderType === 'agent' && message.senderId === role.agentId).length]));
  for (const [role, count] of Object.entries(channelMessageCounts)) if (!count) throw new Error(`${role} has not posted in the actual channel`);
}
console.log(JSON.stringify({
  roomId: receipt.roomId, webUrl: receipt.webUrl,
  channelMessageCounts,
  goals: (state.goals ?? []).map(goal => ({ id: goal.id, attempt: goal.attempt, status: goal.status, reason: goal.reason, budget: goal.budget, usage: goal.usage, activeRuns: goal.activeRuns, attemptHistory: goal.attemptHistory })),
  tasks: state.tasks.map(task => ({ id: task.id, role: task.role, status: task.executionStatus })),
  runs: state.runs.map(run => ({ id: run.id, goalId: run.goalId, goalAttempt: run.goalAttempt, role: run.role, epoch: run.epoch, status: run.status, cleanupState: run.cleanupState, cancelling: Boolean(run.cancelRequestedAt), outcome: run.outcome, error: run.error, artifacts: run.artifacts })),
  events: state.events.slice(-8).map(event => ({ type: event.type, content: event.content.slice(0, 1200) })),
}, null, 2));
if (process.argv.includes('--assert-completed')) {
  const initialTaskIds = receipt.taskIds.length ? receipt.taskIds : state.tasks.map(task => task.id);
  const goalIds = new Set(state.tasks.filter(task => initialTaskIds.includes(task.id)).map(task => task.goalId).filter(Boolean));
  const taskIds = state.tasks.filter(task => goalIds.size ? goalIds.has(task.goalId) : initialTaskIds.includes(task.id)).map(task => task.id);
  const goalRuns = state.runs.filter(run => taskIds.includes(run.taskId));
  const roles = ['planner', 'builder', 'reviewer'];
  for (const role of roles) {
    if (!goalRuns.some(run => run.role === role && run.status === 'completed' && run.artifacts.some(artifact => artifact.type === 'layerfs' && (artifact.refId || artifact.commitId || artifact.layerId)))) throw new Error(`${role} has no completed candidate`);
  }
  if (!goalRuns.some(run => run.role === 'reviewer' && run.status === 'completed' && run.outcome === 'approved')) throw new Error('The reviewer has not approved the candidate');
  if (state.tasks.filter(task => taskIds.includes(task.id)).some(task => task.executionStatus !== 'completed')) throw new Error('There is unfinished work');
  for (const goalId of goalIds) if (!state.goals?.some(goal => goal.id === goalId && goal.status === 'completed')) throw new Error('The durable goal has not completed');
}
