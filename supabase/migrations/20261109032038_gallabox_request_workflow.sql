-- Additive indexes only; existing messages, reviews and classifications are untouched.
-- Rollback: drop these indexes after disabling request writes; retain request records.
CREATE UNIQUE INDEX gallabox_request_origin ON gallabox_private.inbox_record((body->>'originMessageId')) WHERE kind='servicerequests';
CREATE INDEX gallabox_request_queue ON gallabox_private.inbox_record((body->>'ownerId'),(body->>'status'),(body->>'receivedAt'),id) WHERE kind='servicerequests';
CREATE OR REPLACE FUNCTION gallabox_private.guard_workflow_writer() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.kind IN ('servicerequests','servicerules','serviceissues','servicereviews','serviceactions','servicecommands','servicestaffprofiles','serviceallocationstates')
 AND EXISTS(SELECT 1 FROM gallabox_private.worker_control WHERE singleton AND workflow_mode='cloud')
 AND COALESCE(current_setting('gallabox.workflow_writer',true),'')<>'cloud'
 AND NOT (COALESCE(current_setting('gallabox.capture_writer',true),'')='hosted' AND NEW.kind IN ('serviceissues','servicereviews'))
 THEN RAISE EXCEPTION 'Gallabox workflow records require a cloud transaction'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gallabox_private.guard_workflow_writer() FROM PUBLIC,anon,authenticated;
