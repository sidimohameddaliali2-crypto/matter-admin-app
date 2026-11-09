-- Derived reporting only, computed in Supabase rather than on inbox requests.
CREATE MATERIALIZED VIEW gallabox_private.reply_turn_metrics AS
SELECT t.*,gallabox_private.business_seconds(t.started_at,t.replied_at) business_seconds,
statement_timestamp() measured_at FROM gallabox_private.reply_turns t;
CREATE UNIQUE INDEX reply_turn_metrics_identity ON gallabox_private.reply_turn_metrics(conversation_id,turn);
CREATE INDEX reply_turn_metrics_started ON gallabox_private.reply_turn_metrics(started_at);
REVOKE ALL ON gallabox_private.reply_turn_metrics FROM PUBLIC,anon,authenticated;
