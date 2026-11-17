// Closed phrases explain common failures without copying customer data or raw
// exception text into the activity feed.
export function responseIssue(body, status) {
  const message = typeof body?.message === 'string' ? body.message : '';
  if (/already exists|duplicate/i.test(message))
    return 'A matching record already exists, so the new entry was not saved.';
  if (/required|provide valid|invalid/i.test(message) && status >= 400)
    return 'Some required information was missing or invalid, so the change was not accepted.';
  if (/permission|access denied|not authorized/i.test(message) && status === 403)
    return 'This person did not have permission to make the change.';
  if (/not found/i.test(message) && status === 404)
    return 'The record could not be found, so the change was not made.';
  if (/stale|changed|version|conflict/i.test(message) && status === 409)
    return 'Someone changed the record first. The newer version needs to be loaded before retrying.';
  return null;
}
