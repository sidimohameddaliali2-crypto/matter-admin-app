import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createActivityJournal } from './activityJournal.js';
import { activityActor, safeChanges } from './activityPolicy.js';
import { describeActivity } from './activityLanguage.js';

const defaultDirectory = fileURLToPath(new URL('../.activity-journal', import.meta.url));
const collection = () => mongoose.connection.db.collection('activity_audit_events');
const connected = () => mongoose.connection.readyState === 1;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const activityJournal = createActivityJournal({
  directory: path.resolve(process.env.MATTER_ACTIVITY_JOURNAL_DIR || defaultDirectory),
  connected,
  persist: (event) =>
    collection().updateOne(
      { _id: event.eventId },
      { $setOnInsert: event },
      { upsert: true, writeConcern: { w: 'majority' } },
    ),
  list: async ({ limit, q, issues, before }) => {
    const filter = {};
    if (issues) filter.issue = { $nin: [null, ''] };
    if (q) {
      filter.$text = { $search: q };
      filter.$and = q
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 20)
        .map((word) => ({
          $or: ['summary', 'area', 'action', 'issue', 'actor.name'].map((field) => ({
            [field]: { $regex: escapeRegex(word), $options: 'i' },
          })),
        }));
    }
    if (before) {
      const cursor = {
        $or: [
          { occurredAt: { $lt: before.occurredAt } },
          { occurredAt: before.occurredAt, eventId: { $lt: before.eventId } },
        ],
      };
      filter.$and = [...(filter.$and || []), cursor];
    }
    return collection()
      .find(filter, { projection: { _id: 0 } })
      .sort({ occurredAt: -1, eventId: -1 })
      .limit(limit)
      .toArray();
  },
});
let timer;
let captureFailures = 0;

export async function recordActivity(event) {
  const value = { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...event };
  try {
    await activityJournal.append(value);
    return value;
  } catch {
    if (connected()) {
      try {
        await collection().updateOne(
          { _id: value.eventId },
          { $setOnInsert: value },
          { upsert: true, writeConcern: { w: 'majority' } },
        );
        return value;
      } catch {
        /* A visible gap is reported if both durable paths fail. */
      }
    }
    captureFailures++;
    activityJournal.markFailure();
    console.error('ACTIVITY_HISTORY_WRITE_FAILED');
    return null;
  }
}
export async function readActivity(input = 100) {
  const options = typeof input === 'number' ? { limit: input } : input;
  const limit = Math.max(1, Math.min(500, options.limit || 100));
  const result = await activityJournal.read({ ...options, limit: limit * 3 });
  const finished = new Set(
    result.events
      .filter((event) =>
        ['record_saved', 'record_not_saved', 'record_not_changed'].includes(event.stage),
      )
      .map((event) => event.operationId)
      .filter(Boolean),
  );
  result.events = result.events.filter(
    (event) =>
      !['record_change_started', 'record_waiting_for_commit'].includes(event.stage) ||
      !finished.has(event.operationId),
  );
  const more = result.events.length > limit || result.hasMore;
  result.events = result.events.slice(0, limit);
  const last = result.events.at(-1);
  result.nextCursor =
    more && last
      ? Buffer.from(
          JSON.stringify({ occurredAt: last.occurredAt, eventId: last.eventId }),
        ).toString('base64url')
      : null;
  return {
    ...result,
    coverage: {
      formCapture: true,
      serverChanges: true,
      captureFailures,
      limitations: [
        'Form edits show what was entered, not proof that it was saved.',
        'Passwords, private notes, identity documents and other sensitive values are hidden.',
        'Saved entries confirm app database changes. Other systems must confirm their own results.',
        'Earlier values were observed before saving; simultaneous edits can affect them.',
      ],
    },
  };
}
export function startActivityHistory() {
  if (timer) return;
  void activityJournal.recover().catch(() => activityJournal.markFailure());
  timer = setInterval(() => {
    void activityJournal.recover().catch(() => activityJournal.markFailure());
  }, 5000);
  timer.unref?.();
  mongoose.connection.on('connected', async () => {
    try {
      await collection().createIndex({ occurredAt: -1, eventId: -1 });
      await collection().createIndex({ 'actor.id': 1, occurredAt: -1 });
      await collection().createIndex(
        { summary: 'text', 'actor.name': 'text', area: 'text', issue: 'text' },
        { name: 'activity_search', default_language: 'none' },
      );
      await activityJournal.flush();
    } catch {
      activityJournal.markFailure();
    }
  });
}

export async function recordRequestActivity(req, res, { route, disconnected, context }) {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (
    (!write &&
      res.statusCode < 400 &&
      !res.locals.traceOutcome &&
      !res.locals.activityResponseFailed &&
      !res.locals.activityResponsePartial) ||
    route.path.startsWith('/api/traceability')
  )
    return;
  if (!route.path.startsWith('/api/')) return;
  const actor = activityActor(req);
  const outcome = disconnected
    ? 'uncertain'
    : res.statusCode >= 500
      ? 'failed'
      : res.statusCode >= 400
        ? 'rejected'
        : res.locals.activityResponseFailed
          ? 'failed'
          : res.locals.activityResponsePartial
            ? 'partial'
            : res.locals.traceOutcome === 'degraded'
              ? 'degraded'
              : 'accepted';
  const language = describeActivity({
    method: req.method,
    path: route.path,
    body: req.body,
    statusCode: disconnected ? 0 : res.statusCode,
    actorName: actor.name,
    outcome: disconnected ? 'disconnected' : outcome,
  });
  if (res.locals.activityIssue) {
    language.issue = res.locals.activityIssue;
    const reason = language.issue.startsWith('A matching')
      ? 'a matching record already exists'
      : language.issue.startsWith('Some required')
        ? 'required information was missing or invalid'
        : language.issue.startsWith('This person')
          ? 'they did not have permission'
          : language.issue.startsWith('Someone changed')
            ? 'someone changed the record first'
            : language.issue.startsWith('The record could')
              ? 'the record could not be found'
              : null;
    if (reason)
      language.summary =
        actor.name +
        ' could not ' +
        language.action.charAt(0).toLowerCase() +
        language.action.slice(1) +
        ' because ' +
        reason +
        '.';
  }
  await recordActivity({
    actor,
    ...language,
    stage: 'action_response',
    outcome,
    requestId: context.request_id,
    actionId: context.actionId,
    changes: write ? safeChanges({}, req.body || {}) : [],
    confirmation:
      'The app response is recorded. Individual database changes have separate saved entries.',
    source: { method: req.method, route: route.path },
  });
}
