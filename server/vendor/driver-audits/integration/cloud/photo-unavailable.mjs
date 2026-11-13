const messages = {
  'no-upload': 'No photo upload recorded.',
  'upload-without-link': 'Upload time recorded. Photo link missing.',
  'not-archived': 'Photo uploaded. No archived copy is available yet.',
  'archive-missing': 'The archived photo file is missing.',
  'record-unavailable': 'This delivery is unavailable in the selected report.',
};

export function unavailablePhoto(reason) {
  return {status:'unavailable', reason, message:messages[reason]};
}

export function unboundPhoto(delivery) {
  if (delivery?.photo_url) return unavailablePhoto('not-archived');
  if (delivery?.raw_upload || delivery?.upload) return unavailablePhoto('upload-without-link');
  return unavailablePhoto(delivery ? 'no-upload' : 'record-unavailable');
}
