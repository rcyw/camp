export function createCounter(initial = 0) {
  if (!Number.isFinite(initial)) throw new TypeError('initial must be finite');
  let value = initial;
  return {
    value: () => value,
    increment: () => ++value,
  };
}
