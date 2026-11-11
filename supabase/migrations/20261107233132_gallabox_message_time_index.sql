-- Compact, transactionally maintained search index. Canonical messages stay intact.
CREATE TABLE gallabox_private.message_time (
 id text PRIMARY KEY, conversation_id text NOT NULL, sent_at text NOT NULL
);
ALTER TABLE gallabox_private.message_time ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gallabox_private.message_time FROM PUBLIC,anon,authenticated;
CREATE INDEX message_time_conversation ON gallabox_private.message_time(conversation_id,sent_at);
CREATE INDEX message_time_date ON gallabox_private.message_time(sent_at,conversation_id);
CREATE FUNCTION gallabox_private.index_message_time() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.kind='servicemessages' THEN
  INSERT INTO gallabox_private.message_time(id,conversation_id,sent_at) VALUES(NEW.id,NEW.body->>'conversationId',NEW.body->>'sentAt')
  ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,sent_at=excluded.sent_at;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gallabox_private.index_message_time() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER gallabox_index_message_time AFTER INSERT OR UPDATE OF body ON gallabox_private.inbox_record FOR EACH ROW EXECUTE FUNCTION gallabox_private.index_message_time();
INSERT INTO gallabox_private.message_time(id,conversation_id,sent_at) SELECT id,body->>'conversationId',body->>'sentAt' FROM gallabox_private.inbox_record WHERE kind='servicemessages';
ANALYZE gallabox_private.message_time;
