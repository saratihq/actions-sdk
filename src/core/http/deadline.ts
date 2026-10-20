const deadlines = new WeakSet<AbortSignal>();

/** Records that `signal` always aborts at a deadline of its own, and returns it. */
export function markDeadline(signal: AbortSignal): AbortSignal {
  deadlines.add(signal);
  return signal;
}

/** Whether `signal` was recorded by {@link markDeadline}. */
export function hasDeadline(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && deadlines.has(signal);
}
