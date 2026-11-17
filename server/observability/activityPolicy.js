const sensitive =
  /password|secret|token|authorization|cookie|credential|national.?id|passport|license(number)?|card(number)?|bank|iban|salary|deduction|allerg|medical|diagnos|health|message|comment|body|content|text|notes?|evidence|photo|picture|attachment|signature|phone|email/i;
const secretValue =
  /(?:Bearer\s+|sk-(?:proj-)?|-----BEGIN .*PRIVATE KEY|mongodb(?:\+srv)?:\/\/|[?&](?:token|key|secret)=)/i;
export const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
export const activityText = (value, length = 140) =>
  typeof value === 'string'
    ? value
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, length)
    : '';
export const fieldLabel = (field) =>
  activityText(
    String(field)
      .replace(/^\$(?:set|unset|inc|push|pull)\./, '')
      .replace(/\./g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'),
    100,
  );

export function privateValue(field, value) {
  if (sensitive.test(field) || (typeof value === 'string' && secretValue.test(value)))
    return { value: 'Private value hidden', redacted: true };
  if (value === undefined) return { value: 'Not recorded', redacted: false };
  if (value === null) return { value: 'Empty', redacted: false };
  if (typeof value === 'boolean' || typeof value === 'number') return { value, redacted: false };
  if (value instanceof Date) return { value: value.toISOString(), redacted: false };
  if (Array.isArray(value)) return { value: `${value.length} items`, redacted: false };
  if (typeof value === 'object') {
    if (value?._bsontype === 'ObjectId') return { value: value.toString(), redacted: false };
    return { value: 'Changed fields recorded separately', redacted: false };
  }
  return { value: activityText(String(value), 500), redacted: false };
}

export function safeChanges(before = {}, after = {}, keys = Object.keys(after)) {
  const changes = [];
  const get = (object, key) => key.split('.').reduce((value, segment) => value?.[segment], object);
  const collect = (key, old, next, depth = 0) => {
    if (['_id', '__v', 'createdAt', 'updatedAt'].includes(key) || changes.length >= 80) return;
    if (
      next &&
      typeof next === 'object' &&
      !Array.isArray(next) &&
      !(next instanceof Date) &&
      !next._bsontype &&
      !sensitive.test(key) &&
      depth < 3
    ) {
      for (const child of Object.keys(next))
        collect(`${key}.${child}`, old?.[child], next[child], depth + 1);
      return;
    }
    const a = privateValue(key, old);
    const b = privateValue(key, next);
    if (old === next) return;
    if (typeof old === 'object' && typeof next === 'object') {
      try {
        if (JSON.stringify(old) === JSON.stringify(next)) return;
      } catch {
        /* Non-JSON database values remain summarized. */
      }
    }
    changes.push({
      field: fieldLabel(key),
      before: a.value,
      after: b.value,
      redacted: a.redacted || b.redacted,
    });
  };
  for (const key of keys) collect(key, get(before, key), get(after, key));
  return changes;
}

export function activityActor(request) {
  if (request?.activityActor) return { ...request.activityActor };
  const user =
    request?.user || request?.activityVerifiedLogin || request?.member || request?.partner;
  if (!user)
    return {
      id: null,
      name: request ? 'Unidentified visitor' : 'Automatic process',
      role: request ? 'unknown' : 'system',
      kind: request ? 'anonymous' : 'system',
    };
  const name =
    user.name ||
    user.displayName ||
    [user.profile?.firstName || user.firstName, user.profile?.lastName || user.lastName]
      .filter(Boolean)
      .join(' ') ||
    'Signed-in staff member';
  return {
    kind: request?.member ? 'member' : request?.partner ? 'partner' : 'staff',
    id: String(user._id || user.id || ''),
    name: activityText(name, 100),
    role: activityText(
      user.role || (request.member ? 'member' : request.partner ? 'partner' : 'staff'),
      50,
    ),
  };
}
