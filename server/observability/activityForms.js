import { createHash } from 'node:crypto';
import pathToRegexp from 'path-to-regexp';
import { activityActor, activityText, privateValue, uuid } from './activityPolicy.js';

const allowedStages = new Set(['form_edited', 'form_submitted', 'form_validation_failed']);
const eventIdFor = (actor, id) => {
  const hex = createHash('sha256')
    .update(`${actor.kind || 'staff'}:${actor.id}:${id}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export function formActivity(request, input, catalog) {
  if (!input || !uuid(input.eventId) || !uuid(input.actionId) || !allowedStages.has(input.stage))
    throw Error('Invalid form activity');
  const actor = activityActor(request);
  const pathname = typeof input.page === 'string' ? input.page.split(/[?#]/)[0] : '';
  const page = catalog.browser.find((route) => pathToRegexp(route.path).test(pathname));
  if (!page || page.path === '/traceability') throw Error('Unknown activity page');
  const title = activityText(input.form?.title, 100) || 'a form';
  const field =
    activityText(input.form?.field, 100)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .toLowerCase() || 'a field';
  const changes = (Array.isArray(input.changes) ? input.changes : []).slice(0, 80).map((change) => {
    const key = activityText(change.field, 100) || field;
    const a = privateValue(key, change.before);
    const b = privateValue(key, change.after);
    const hidden = change.redacted === true || a.redacted || b.redacted;
    return {
      field: key,
      before: hidden ? 'Private value hidden' : a.value,
      after: hidden ? 'Private value hidden' : b.value,
      redacted: hidden,
    };
  });
  const edited = input.stage === 'form_edited';
  const invalid = input.stage === 'form_validation_failed';
  const summary = edited
    ? `${actor.name} edited ${field} on ${title}.`
    : invalid
      ? `${actor.name} could not submit ${title} because ${field} needs attention.`
      : `${actor.name} submitted ${title}.`;
  return {
    eventId: eventIdFor(actor, input.eventId),
    clientEventId: input.eventId,
    actionId: input.actionId,
    occurredAt: new Date().toISOString(),
    clientOccurredAt: Number.isFinite(Date.parse(input.occurredAt))
      ? new Date(input.occurredAt).toISOString()
      : null,
    actor,
    area: title,
    action: edited ? 'Edit a form' : invalid ? 'Check a form' : 'Submit a form',
    summary,
    issue: invalid ? `${field} needs a valid value before this form can be submitted.` : null,
    stage: input.stage,
    outcome: edited ? 'draft' : invalid ? 'rejected' : 'submitted',
    changes,
    form: { title, field, page: page.path },
    confirmation:
      'Reported by the signed-in browser. This records input or submission, not a confirmed saved change.',
  };
}
