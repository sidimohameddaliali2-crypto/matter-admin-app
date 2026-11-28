import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { activityActor, safeChanges, privateValue, fieldLabel } from './activityPolicy.js';
import { traceContext } from './telemetry.js';
import { describeActivity } from './activityLanguage.js';
import { shouldAuditModel, isAutomaticDriverLocation, isLocationOnlyUpdate, isAutomaticTrackerVisit } from './activityScope.js';

// The writer fences the update on the prior poll clock. Compare the original
// evidence before it is redacted for display, and retain every baseline write.
function isRepeatTrackerCheck(before, update, filter) {
  const previous = before.trackerVisit;
  const next = update.$set.trackerVisit;
  if (!before._id || !previous?.status || !previous.checkedAt || !(next.checkedAt instanceof Date)
    || !isDeepStrictEqual(filter['trackerVisit.checkedAt'], previous.checkedAt)
    || !isDeepStrictEqual(filter._id, before._id)
    || Object.keys(update.$set).some(key => !['trackerVisit', 'updatedAt'].includes(key))
    || next.errorStage || next.errorCode || ['verification_error', 'tracker_error'].includes(next.status)) return false;

  // Undefined object fields are omitted by the tracker write. A removed
  // stored field, including an old error or GPS observation, is a real change.
  const evidence = visit => Object.fromEntries(Object.entries(visit)
    .filter(([key, value]) => key !== 'checkedAt' && value !== undefined));
  return isDeepStrictEqual(evidence(previous), evidence(next));
}

const pendingWrites = Symbol('activity-pending-writes');
const wrappedSession = Symbol('activity-wrapped-session');
const modelNames = {
  User: 'staff account',
  Delivery: 'delivery',
  Customer: 'customer',
  Bag: 'bag',
  ServiceIssue: 'customer issue',
  ServiceRequest: 'customer issue',
  ServiceAction: 'customer-service action',
  ServiceReview: 'customer-service review',
  WeeklyMenu: 'menu',
  Member: 'member',
  Partner: 'partner',
  Employee: 'employee',
  Vehicle: 'vehicle',
};
const rootPaths = {
  User: '/api/users',
  Delivery: '/api/deliveries',
  Customer: '/api/customers',
  Bag: '/api/bags',
  Vehicle: '/api/vehicles',
  Employee: '/api/employees',
  Partner: '/api/admin/partners',
};
const plain = (value) => (value?.toObject ? value.toObject({ depopulate: true }) : value || {});

export function makeRecordActivity(model, created, before, after, operation) {
  const context = traceContext();
  const req = context?.request;
  const actor = activityActor(req);
  const role = after?.role || before?.role;
  const noun =
    model === 'User' && role === 'driver'
      ? 'driver'
      : modelNames[model] || model.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const path = model === 'User' && role === 'driver' ? '/api/drivers' : rootPaths[model];
  const method = operation === 'delete' ? 'DELETE' : created ? 'POST' : 'PATCH';
  let description;
  if (path)
    description = describeActivity({
      method,
      path: created ? path : `${path}/:id`,
      actorName: actor.name,
      outcome: 'saved',
    });
  else
    description = {
      area: model.startsWith('Service') ? 'Customer Service' : 'App records',
      action: `${created ? 'Add' : operation === 'delete' ? 'Delete' : 'Update'} ${noun}`,
      summary: `${actor.name} ${created ? 'added' : operation === 'delete' ? 'deleted' : 'updated'} a ${noun}.`,
    };
  if (
    model === 'Delivery' &&
    req?.activityRoute?.path?.startsWith('/api/deliveries') &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  ) {
    description = describeActivity({
      method: req.method,
      path: req.activityRoute.path,
      body: req.body,
      actorName: actor.name,
      outcome: 'saved',
    });
    if (req.activityRoute.path === '/api/deliveries/assign-driver' && req.activityTargetName)
      description.summary = actor.name + ' assigned a delivery to ' + req.activityTargetName + '.';
    if (req.activityRoute.path === '/api/deliveries/unassign-driver')
      description.summary = actor.name + ' removed the driver assignment from a delivery.';
  }
  const operationId = randomUUID();
  return {
    operationId,
    eventId: operationId,
    occurredAt: new Date().toISOString(),
    actor,
    ...description,
    requestId: context?.request_id,
    traceId: context?.trace_id,
    runId: context?.run_id,
    job: context?.job,
    actionId: context?.actionId,
    record: { type: model, id: String(after?._id || before?._id || '') },
    stage: 'record_saved',
    outcome: 'saved',
    changes: safeChanges(
      before,
      operation === 'delete' ? {} : after,
      operation === 'delete' ? Object.keys(before) : Object.keys(after),
    ),
  };
}

async function nameDriverChange(event, model, before, after, session) {
  if (model.modelName !== 'Delivery') return;
  const change = event.changes.find((value) => value.field === 'driver');
  if (!change) return;
  const context = traceContext();
  const names = context ? (context.activityNames ||= new Map()) : new Map();
  const lookup = async (id) => {
    if (!id) return 'Unassigned';
    if (names.has(String(id))) return names.get(String(id));
    try {
      const user = await model.db
        .model('User')
        .findById(id)
        .select('profile.firstName profile.lastName')
        .session(session || null)
        .lean();
      const name =
        [user?.profile?.firstName, user?.profile?.lastName].filter(Boolean).join(' ') ||
        'Driver name unavailable';
      names.set(String(id), name);
      return name;
    } catch {
      return 'Driver name unavailable';
    }
  };
  change.references = {
    before: before.driver ? String(before.driver) : null,
    after: after.driver ? String(after.driver) : null,
  };
  [change.before, change.after] = await Promise.all([lookup(before.driver), lookup(after.driver)]);
  change.field = 'Assigned driver';
}

// A transaction's writes are confirmed only after commit. Aborted writes receive
// a separate plain-language outcome and never appear as saved changes.
export function wrapActivitySession(session, write) {
  if (!session || session[wrappedSession]) return session;
  session[wrappedSession] = true;
  session[pendingWrites] = [];
  const start = session.startTransaction.bind(session);
  session.startTransaction = function (...args) {
    const result = start(...args);
    for (const event of session[pendingWrites].splice(0))
      void write({
        ...event,
        eventId: randomUUID(),
        stage: 'record_not_saved',
        outcome: 'uncertain',
        summary: `${event.actor.name} had a transaction attempt replaced by a retry.`,
        issue: 'The earlier attempt was not confirmed. Only the completed retry can confirm saved changes.',
      });
    return result;
  };
  const commit = session.commitTransaction.bind(session);
  session.commitTransaction = async function (...args) {
    const result = await commit(...args);
    const events = session[pendingWrites].splice(0);
    for (const event of events)
      await write({
        ...event,
        occurredAt: new Date().toISOString(),
        stage: 'record_saved',
        outcome: 'saved',
        issue: null,
      });
    return result;
  };
  const abort = session.abortTransaction.bind(session);
  session.abortTransaction = async function (...args) {
    const result = await abort(...args);
    for (const event of session[pendingWrites].splice(0))
      await write({
        ...event,
        eventId: randomUUID(),
        stage: 'record_not_saved',
        outcome: 'rejected',
        summary: `${event.actor.name} made a change that was rolled back.`,
        issue: 'The database transaction was cancelled, so this change was not saved.',
      });
    return result;
  };
  return session;
}
async function complete(event, session, write) {
  if (session?.inTransaction()) {
    const pending = {
      ...event,
      stage: 'record_waiting_for_commit',
      outcome: 'pending',
      summary: `${event.actor.name} prepared a change. The database transaction has not been confirmed.`,
      issue: null,
    };
    await write({ ...pending, eventId: randomUUID() });
    if (session[wrappedSession]) session[pendingWrites].push(event);
    return;
  }
  await write(event);
}

export function createActivityPlugin({ write }) {
  return function activityPlugin(schema) {
    if (schema.options.activityAudit === false) return;
    schema.pre('save', async function () {
      if (!this.constructor.modelName || !shouldAuditModel(this.constructor.modelName)) return;
      const after = plain(this);
      let before = {};
      if (!this.isNew) {
        try {
          before =
            (await this.constructor.findById(this._id).session(this.$session()).lean()) || {};
        } catch {
          /* Preserve the application write; mark the unavailable previous image below. */
        }
      }
      const event = makeRecordActivity(
        this.constructor.modelName,
        this.isNew,
        before,
        after,
        'save',
      );
      await nameDriverChange(event, this.constructor, before, after, this.$session());
      event.previousValuesObserved = !this.isNew;
      this.$locals.activityEvent = event;
      this.$locals.activityWasNew = this.isNew;
      if (event.changes.length || this.isNew)
        await write({
          ...event,
          eventId: randomUUID(),
          stage: 'record_change_started',
          outcome: 'pending',
          summary: `${event.actor.name} started saving ${event.action.toLowerCase().replace(/^(add|update) /, '')}.`,
          issue: null,
        });
    });
    schema.post('save', async function (document) {
      const event = document.$locals.activityEvent;
      if (event && (event.changes.length || document.$locals.activityWasNew))
        await complete(
          { ...event, occurredAt: new Date().toISOString() },
          document.$session(),
          write,
        );
    });
    for (const operation of [
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'findOneAndReplace',
      'deleteOne',
      'deleteMany',
      'findOneAndDelete',
    ]) {
      schema.pre(operation, { query: true, document: false }, async function () {
        if (!shouldAuditModel(this.model.modelName)) return;
        const proposed = this.getUpdate?.() || {};
        if (this.model.modelName === 'User' && isAutomaticDriverLocation(traceContext()?.request) && isLocationOnlyUpdate(proposed)) return;
        let before = {};
        try {
          before =
            (await this.model
              .findOne(this.getFilter())
              .session(this.getOptions().session || null)
              .lean()) || {};
        } catch {
          /* Previous values remain explicitly unavailable. */
        }
        const update = this.getUpdate?.() || {};
        const after = { ...before };
        const changes = [];
        const operators = Object.keys(update).some((key) => key.startsWith('$'))
          ? update
          : { $set: update };
        for (const [operator, fields] of Object.entries(operators)) {
          for (const [key, value] of Object.entries(fields || {})) {
            const previous = key.split('.').reduce((v, part) => v?.[part], before);
            let next = value;
            if (operator === '$unset') next = null;
            if (operator === '$inc') next = typeof previous === 'number' ? previous + value : value;
            const a = privateValue(key, previous);
            const b = privateValue(key, next);
            changes.push({
              field: fieldLabel(key),
              before: a.value,
              after: b.value,
              redacted: a.redacted || b.redacted,
            });
            after[key] = next;
          }
        }
        const event = makeRecordActivity(
          this.model.modelName,
          false,
          before,
          after,
          operation.toLowerCase().includes('delete') ? 'delete' : 'update',
        );
        event.changes = operation.toLowerCase().includes('delete')
          ? safeChanges(before, {}, Object.keys(before))
          : changes;
        await nameDriverChange(event, this.model, before, after, this.getOptions().session);
        event.previousValuesObserved = true;
        event.confirmation =
          'Previous values were observed before the write. Submitted values can be affected by concurrent edits and database update operators.';
        this.activityEvent = event;
        this.activityStartedDeferred = isAutomaticTrackerVisit(traceContext(), this.model.modelName, operation, proposed, this.getOptions());
        this.activityRepeatTrackerCheck = this.activityStartedDeferred && isRepeatTrackerCheck(before, proposed, this.getFilter());
        if (!this.activityStartedDeferred) await write({
          ...event,
          eventId: randomUUID(),
          stage: 'record_change_started',
          outcome: 'pending',
          summary: `${event.actor.name} started changing ${modelNames[this.model.modelName] || 'an app record'}.`,
          issue: null,
        });
      });
      schema.post(operation, { query: true, document: false }, async function (result) {
        if (!this.activityEvent) return;
        const count = result?.modifiedCount ?? result?.deletedCount ?? result?.lastErrorObject?.n;
        const changed = count > 0 || result?.upsertedCount > 0 || result?._id || result?.value?._id;
        if (!changed) {
          await write({
            ...this.activityEvent,
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            stage: 'record_not_changed',
            outcome: 'accepted',
            summary:
              this.activityEvent.actor.name +
              ' submitted a change, but no matching records were changed.',
            issue: null,
          });
          return;
        }
        if (this.activityRepeatTrackerCheck && result?.acknowledged === true
          && result.matchedCount === 1 && result.modifiedCount === 1) return;
        await complete(
          {
            ...this.activityEvent,
            occurredAt: new Date().toISOString(),
            affectedRecords: count || 1,
            ...(count > 1
              ? {
                  summary:
                    this.activityEvent.actor.name +
                    ' changed ' +
                    count +
                    ' records in ' +
                    this.activityEvent.area +
                    '.',
                  confirmation:
                    'This operation changed ' +
                    count +
                    ' records. Earlier values shown are from one matching record observed before the write.',
                }
              : {}),
          },
          this.getOptions().session,
          write,
        );
      });
      if (operation === 'updateOne') schema.post(operation, { query: true, document: false }, function (error, _result, next) {
        if (!this.activityStartedDeferred || !this.activityEvent) return next(error);
        // Keep failed attempts visible without serializing the provider/DB error
        // (which may contain credentials). Never replace the original failure.
        Promise.resolve().then(() => write({
          ...this.activityEvent,
          eventId: randomUUID(), occurredAt: new Date().toISOString(),
          stage: 'record_not_saved', outcome: 'uncertain',
          summary: 'The automated tracker verdict update was not confirmed.',
          issue: 'The tracker write failed or its audit confirmation failed. Retain the evidence and retry; no saved outcome is inferred.'
        })).then(() => next(error), () => next(error));
      });
    }
    schema.post('insertMany', function (error, documents, next) {
      if (!shouldAuditModel(this.modelName)) return next(error);
      const recordInserted = async () => {
        for (const document of error.insertedDocs || []) {
          await complete(
            makeRecordActivity(this.modelName, true, {}, plain(document), 'save'),
            document.$session?.(),
            write,
          );
        }
      };
      recordInserted().then(
        () => next(error),
        () => next(error),
      );
    });
    schema.post('insertMany', async function (documents) {
      if (!shouldAuditModel(this.modelName)) return;
      for (const doc of documents)
        await complete(
          makeRecordActivity(this.modelName, true, {}, plain(doc), 'save'),
          doc.$session?.(),
          write,
        );
    });
  };
}

export function installActivityDatabase(mongoose, write) {
  mongoose.plugin(createActivityPlugin({ write }));
  const startSession = mongoose.Connection.prototype.startSession;
  mongoose.Connection.prototype.startSession = async function (...args) {
    return wrapActivitySession(await startSession.apply(this, args), write);
  };
  const bulkWrite = mongoose.Model.bulkWrite;
  mongoose.Model.bulkWrite = async function (operations, options, ...args) {
    if (this.schema?.options.activityAudit === false || !shouldAuditModel(this.modelName))
      return bulkWrite.call(this, operations, options, ...args);
    const context = traceContext();
    const actor = activityActor(context?.request);
    const operationId = randomUUID();
    const event = {
      eventId: operationId,
      operationId,
      occurredAt: new Date().toISOString(),
      actor,
      area: 'App records',
      action: 'Change several records',
      summary: `${actor.name} submitted changes to several ${modelNames[this.modelName] || 'app records'}.`,
      stage: 'record_change_started',
      outcome: 'pending',
      requestId: context?.request_id,
      actionId: context?.actionId,
      changes: [],
      record: { type: this.modelName },
      submittedOperations: operations.length,
    };
    await write(event);
    let result;
    try {
      result = await bulkWrite.call(this, operations, options, ...args);
    } catch (error) {
      await write({
        ...event,
        eventId: randomUUID(),
        stage: 'record_batch_result',
        outcome: 'uncertain',
        issue: 'A batch write failed. Some records may have changed before the failure.',
      });
      throw error;
    }
    const affected =
      (result.modifiedCount || 0) +
      (result.insertedCount || 0) +
      (result.deletedCount || 0) +
      (result.upsertedCount || 0);
    if (affected)
      await complete(
        {
          ...event,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          stage: 'record_saved',
          outcome: 'saved',
          affectedRecords: affected,
          summary: `${actor.name} changed ${affected} ${modelNames[this.modelName] || 'app records'}.`,
        },
        options?.session,
        write,
      );
    return result;
  };
}
