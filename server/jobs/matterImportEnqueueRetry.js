// Retain the original service date through temporary queue/DB failures. The
// next daily run may add another date, but must not replace a pending retry.
export function createScheduledImportEnqueuer({ enqueue, setTimer = setTimeout,
  clearTimer = clearTimeout, retryMs = 60000, onError = date => console.error(`[MatterImport] Could not queue ${date}; retrying that date.`) }) {
  const pending = new Map();
  let stopped = false;
  const attempt = async (date, entry) => {
    try {
      await enqueue(date);
      pending.delete(date);
    } catch {
      if (stopped) return;
      onError(date);
      const delay = Math.min(retryMs * (2 ** entry.failures++), 5 * 60000);
      entry.timer = setTimer(() => {
        entry.timer = null;
        entry.attempt = attempt(date, entry);
      }, delay);
      entry.timer?.unref?.();
    }
  };
  return {
    queue(date) {
      if (stopped) return Promise.resolve();
      if (pending.has(date)) return pending.get(date).attempt;
      const entry = { failures: 0, timer: null };
      pending.set(date, entry);
      entry.attempt = attempt(date, entry);
      return entry.attempt;
    },
    stop() {
      stopped = true;
      for (const entry of pending.values()) if (entry.timer) clearTimer(entry.timer);
      pending.clear();
    }
  };
}
