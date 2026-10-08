// Work to undo when a signal stops relay in the middle of a command: temporary files that may hold
// a secret, and a job folder that relay init had only half written. main.ts runs every registered
// action as soon as a SIGINT or SIGTERM arrives. An action registered after that, by a command
// that kept running while git was being stopped, runs at once.
const actions = new Set<() => void>();
let interrupted = false;

// Registers `action` and returns the function that removes it again once the work is done.
export function onInterrupt(action: () => void): () => void {
  if (interrupted) {
    runAction(action);
    return () => {};
  }
  actions.add(action);
  return () => actions.delete(action);
}

// Whether a signal is stopping relay, so a command can say so instead of reporting the git
// process the signal ended.
export function wasInterrupted(): boolean {
  return interrupted;
}

export function runInterruptActions(): void {
  interrupted = true;
  for (const action of [...actions]) {
    actions.delete(action);
    runAction(action);
  }
}

function runAction(action: () => void): void {
  try {
    action();
  } catch {
    // Each action is tried, even when an earlier one fails.
  }
}
