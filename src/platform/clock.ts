// The one clock of the program (add-provider-adapters, design decision 17). Every comparison with
// a reset time, a log's age or a policy's age reads the time through now(), so a test can move
// past a five-hour reset without waiting.
let current: () => Date = () => new Date();

export function now(): Date {
  return current();
}

// For tests only: replaces the clock, or restores the real one when given null.
export function setClock(clock: (() => Date) | null): void {
  current = clock ?? (() => new Date());
}
