-- PREPARED ONLY: apply only after explicit cloud migration authorization.
-- Existing records retain their IDs/payloads/history; missing issue keys are primary.
-- Create replacement protection before removing the old single-origin constraint.
BEGIN;
CREATE UNIQUE INDEX gallabox_request_origin_issue ON gallabox_private.inbox_record
 ((body->>'originMessageId'),(COALESCE(body->>'originIssueKey','primary')))
 WHERE kind='servicerequests';
DROP INDEX gallabox_private.gallabox_request_origin;
COMMIT;
-- Rollback is NOT an unconditional index recreation: multiple approved issues may
-- now share an origin. Disable split commands first; retain all child requests.
-- Do not delete/merge records to restore the old uniqueness rule.
