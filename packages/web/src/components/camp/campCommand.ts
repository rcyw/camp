/** Explicit room execution command; ordinary channel conversation has no side effect. */
export function parseCampGoal(content: string): string | null {
  const match = /^\/camp(?:\s|$)/i.exec(content.trimStart());
  return match ? content.trimStart().slice(match[0].length).trim() : null;
}
