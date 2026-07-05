/**
 * Per-key async serializer.
 *
 * Ingestion re-entrancy guard: the watcher's debounce only serializes the
 * *timer* per file path, not any in-flight scan — two concurrent
 * `ingestBatch` calls for the SAME project (e.g. a debounced watcher scan
 * racing a hook-triggered rescan) would both reach into the project's
 * single `ShadowSnapshotter` (shared `GIT_INDEX_FILE`, a non-atomic
 * prevHead -> commit-tree -> update-ref sequence) at once, risking
 * `index.lock` failures or a clobbered ref.
 *
 * `runSerialized(key, fn)` chains every call for the same `key` onto a
 * promise queue, so calls for that key always run one-at-a-time, in the
 * order they were submitted. Calls for a DIFFERENT key are independent —
 * they are not queued behind each other's chains at all.
 *
 * Memory: the queue does not grow unboundedly. Each key only ever holds
 * the tail promise of its own chain (a queue "replaces its entry" rather
 * than accumulating one); once a chain settles and no newer call has
 * since replaced it, the entry is deleted from the map entirely.
 */

const chains = new Map<string, Promise<unknown>>();

export function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();

  // Always run `fn` after the previous call for this key settles
  // (successfully or not) — a rejection must not permanently wedge the
  // queue for later callers.
  const next = previous.then(fn, fn);

  // Swallow the result/rejection for the purposes of the *queue's own*
  // bookkeeping promise (chains map), so an upstream rejection doesn't
  // become an unhandled rejection just from being stored here. The
  // caller still gets the real `next` (with its real rejection) below.
  const settleTracker = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settleTracker);

  const cleanup = (): void => {
    // Only clear this key's entry if nothing newer has replaced it in the
    // meantime (a call submitted while we were running would have already
    // overwritten `chains.get(key)` with its own tracker).
    if (chains.get(key) === settleTracker) {
      chains.delete(key);
    }
  };

  // Run cleanup as a continuation of `next` itself (not of the separately
  // derived `settleTracker`) so it is guaranteed to have run by the time
  // any `await runSerialized(...)` at the call site resolves — otherwise
  // callers that immediately check queue size after their own await could
  // observe a stale (not-yet-cleaned-up) entry.
  return next.then(
    (value) => {
      cleanup();
      return value;
    },
    (err) => {
      cleanup();
      throw err;
    },
  );
}

/** Test-only: number of keys currently holding a pending/settling chain
 * entry, used to assert the map doesn't grow unboundedly. */
export function __pendingKeyCount(): number {
  return chains.size;
}
