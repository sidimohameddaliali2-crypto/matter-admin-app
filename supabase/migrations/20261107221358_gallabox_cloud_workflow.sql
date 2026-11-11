ALTER TABLE gallabox_private.worker_control ADD COLUMN workflow_mode text NOT NULL DEFAULT 'local' CHECK(workflow_mode IN ('local','cloud'));
CREATE UNIQUE INDEX gallabox_review_sample ON gallabox_private.inbox_record ((body->>'issueId'),(COALESCE(body->>'sampleKey','primary'))) WHERE kind='servicereviews';
CREATE UNIQUE INDEX gallabox_one_active_review ON gallabox_private.inbox_record ((body->>'reviewerId')) WHERE kind='servicereviews' AND body->>'status'='in_review' AND body->>'reviewerId' IS NOT NULL;
CREATE UNIQUE INDEX gallabox_workflow_request ON gallabox_private.inbox_record ((body->>'requestId')) WHERE kind='servicecommands';
CREATE UNIQUE INDEX gallabox_staff_membership ON gallabox_private.inbox_record ((body->>'userId')) WHERE kind='servicestaffprofiles';
CREATE UNIQUE INDEX gallabox_issue_episode ON gallabox_private.inbox_record ((body->>'conversationId'),(COALESCE(body->>'episodeKey','primary'))) WHERE kind='serviceissues';
CREATE FUNCTION gallabox_private.guard_workflow_writer() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.kind IN ('serviceissues','servicereviews','serviceactions','servicecommands','servicestaffprofiles','serviceallocationstates')
 AND EXISTS(SELECT 1 FROM gallabox_private.worker_control WHERE singleton AND workflow_mode='cloud')
 AND COALESCE(current_setting('gallabox.workflow_writer',true),'')<>'cloud'
 AND NOT (COALESCE(current_setting('gallabox.capture_writer',true),'')='hosted' AND NEW.kind IN ('serviceissues','servicereviews'))
 THEN RAISE EXCEPTION 'Gallabox workflow records require a cloud transaction'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gallabox_private.guard_workflow_writer() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER gallabox_workflow_writer BEFORE INSERT OR UPDATE ON gallabox_private.inbox_record FOR EACH ROW EXECUTE FUNCTION gallabox_private.guard_workflow_writer();
CREATE TABLE gallabox_private.staff_directory (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{24}$'),account_id text NOT NULL,provider_id text NOT NULL,
 display_name text NOT NULL,email text,active boolean NOT NULL,observed_at timestamptz NOT NULL,
 UNIQUE(account_id,provider_id)
);
ALTER TABLE gallabox_private.staff_directory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gallabox_private.staff_directory FROM PUBLIC,anon,authenticated;
