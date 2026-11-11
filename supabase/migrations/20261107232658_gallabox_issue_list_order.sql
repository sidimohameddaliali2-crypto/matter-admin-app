CREATE INDEX gallabox_issue_list_order ON gallabox_private.inbox_record ((body->>'updatedAt') DESC,id) WHERE kind='serviceissues';
ANALYZE gallabox_private.inbox_record;
