import {
  mkdir,
  chmod,
  open,
  link,
  readdir,
  readFile,
  unlink,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const provisionalStages = ['record_change_started', 'record_waiting_for_commit'];
export const terminalStages = ['record_saved', 'record_not_saved', 'record_not_changed', 'record_batch_result'];

// Each event is committed to a private disk file before database delivery. Stable
// event IDs make retries and concurrent process drains idempotent in Mongo.
export function createActivityJournal({
  directory,
  persist,
  list,
  resolveOperations = async () => [],
  connected = () => false,
  maxPending = 50000,
} = {}) {
  let initialized;
  let flight;
  let lastError = null;
  let recoveryIssue = null;
  const initialize = () =>
    (initialized ||= mkdir(directory, { recursive: true, mode: 0o700 })
      .then(() => chmod(directory, 0o700))
      .catch((error) => {
        initialized = null;
        throw error;
      }));
  const filenames = async () => {
    await initialize();
    return (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  };
  const acknowledge = async (file) => {
    try {
      await unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  async function flush() {
    if (flight || !connected()) return flight;
    flight = (async () => {
      for (const name of await filenames()) {
        const file = path.join(directory, name);
        let event;
        try {
          event = JSON.parse(await readFile(file, 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        await persist(event);
        await acknowledge(file);
      }
      lastError = null;
    })()
      .catch(() => {
        lastError =
          'Activity history could not reach the database. Saved disk entries will be retried.';
      })
      .finally(() => {
        flight = null;
      });
    return flight;
  }
  async function append(event) {
    await initialize();
    if ((await filenames()).length >= maxPending) throw Error('Activity journal is full');
    const temporary = path.join(directory, `${event.eventId}.${randomUUID()}.tmp`);
    const final = path.join(directory, `${event.eventId}.json`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(event));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, final);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await acknowledge(temporary);
    // Directory sync protects the committed filename when a host loses power.
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    void flush();
    return event;
  }
  async function pending() {
    const result = [];
    for (const name of await filenames()) {
      try {
        result.push(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') lastError = 'An activity journal entry could not be read.';
      }
    }
    return result;
  }
  return {
    append,
    flush,
    async read({ limit = 100, q = '', issues = false, before = null } = {}) {
      let disk = [];
      try {
        disk = await pending();
      } catch {
        lastError =
          'Pending disk history could not be read. Database history is shown when available.';
      }
      let stored = [];
      const finished = new Set(disk.filter(event => terminalStages.includes(event.stage)).map(event => event.operationId).filter(Boolean));
      if (connected()) {
        try {
          const pendingIds = [...new Set(disk.filter(event => provisionalStages.includes(event.stage)).map(event => event.operationId).filter(Boolean))];
          for (const id of await resolveOperations(pendingIds)) finished.add(id);
          stored = await list({ limit: limit + 1, q, issues, before, completedOperations: [...finished] });
        } catch {
          lastError =
            'Stored activity history could not be loaded. Pending disk entries are shown.';
        }
      }
      const byId = new Map([...disk, ...stored].map((event) => [event.eventId, event]));
      const matching = [...byId.values()].filter((event) => {
        if (provisionalStages.includes(event.stage) && finished.has(event.operationId)) return false;
        if (issues && !event.issue) return false;
        if (
          before &&
          (event.occurredAt > before.occurredAt ||
            (event.occurredAt === before.occurredAt && event.eventId >= before.eventId))
        )
          return false;
        const text = [event.summary, event.area, event.action, event.issue, event.actor?.name]
          .join(' ')
          .toLowerCase();
        return q
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((word) => text.includes(word));
      });
      const hasMore = matching.length > limit;
      const events = matching
        .sort(
          (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.eventId.localeCompare(a.eventId),
        )
        .slice(0, limit);
      return {
        events,
        hasMore,
        storage: {
          kind: connected() ? 'mongo' : 'disk',
          durable: true,
          pending: disk.length,
          issue: recoveryIssue || lastError,
        },
      };
    },
    async recover() {
      await initialize();
      // A completed tmp file can be recovered after a process crashed before linking.
      for (const name of (await readdir(directory)).filter((value) => value.endsWith('.tmp'))) {
        const file = path.join(directory, name);
        const info = await stat(file);
        if (Date.now() - info.mtimeMs < 60000) continue;
        try {
          const event = JSON.parse(await readFile(file, 'utf8'));
          if (!/^[a-f0-9-]{36}$/.test(event.eventId)) throw Error('Invalid event');
          try {
            await link(file, path.join(directory, `${event.eventId}.json`));
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
          await acknowledge(file);
        } catch {
          recoveryIssue = 'An interrupted activity entry needs inspection in the private journal.';
        }
      }
      return flush();
    },
    failure() {
      return lastError;
    },
    markFailure() {
      lastError = 'Some activity could not be written. Activity history may be incomplete.';
    },
  };
}
