/**
 * Simple async mutual-exclusion lock.
 * Callers queue up and execute one at a time; zero overhead when uncontended.
 */
export class AsyncMutex {
  private _tail: Promise<void> = Promise.resolve();

  /** Run fn exclusively; waits for any in-flight holder to finish first. */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this._tail.then(() => fn());
    // Advance the queue tail, swallowing the result error so the next waiter
    // is always unblocked regardless of whether fn threw.
    this._tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
