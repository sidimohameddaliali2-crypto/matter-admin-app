CREATE TABLE gallabox_private.client_checkpoint (id text PRIMARY KEY,published_at timestamptz NOT NULL);
ALTER TABLE gallabox_private.client_checkpoint ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gallabox_private.client_checkpoint FROM PUBLIC,anon,authenticated;
CREATE FUNCTION gallabox_private.guard_capture_writer() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.kind IN ('servicemessages','serviceconversations','servicecapturebatches','servicegallaboxsyncs','servicesourcecontacts')
 AND EXISTS(SELECT 1 FROM gallabox_private.worker_control WHERE singleton AND writer_mode='cloud')
 AND COALESCE(current_setting('gallabox.capture_writer',true),'')<>'hosted'
 THEN RAISE EXCEPTION 'Gallabox source records belong to hosted capture'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gallabox_private.guard_capture_writer() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER gallabox_capture_writer BEFORE INSERT OR UPDATE ON gallabox_private.inbox_record FOR EACH ROW EXECUTE FUNCTION gallabox_private.guard_capture_writer();
