CREATE INDEX gallabox_review_owner ON gallabox_private.inbox_record ((body->>'reviewerId'),(body->>'status')) WHERE kind='servicereviews';
CREATE INDEX gallabox_action_owner ON gallabox_private.inbox_record ((body->>'ownerId'),(body->>'status')) WHERE kind='serviceactions';
CREATE INDEX gallabox_action_issue ON gallabox_private.inbox_record ((body->>'issueId')) WHERE kind='serviceactions';
