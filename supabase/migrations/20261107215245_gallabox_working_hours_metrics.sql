-- Owner-defined hours; source messages/reviews are unchanged.
CREATE OR REPLACE FUNCTION gallabox_private.business_seconds(start_at timestamptz,end_at timestamptz)
RETURNS double precision LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT COALESCE(sum(GREATEST(0,extract(epoch FROM LEAST(end_at,(d::date+time '17:00') AT TIME ZONE 'Asia/Dubai') - GREATEST(start_at,(d::date+time '08:00') AT TIME ZONE 'Asia/Dubai')))),0)::double precision
 FROM generate_series((start_at AT TIME ZONE 'Asia/Dubai')::date::timestamp,(end_at AT TIME ZONE 'Asia/Dubai')::date::timestamp,interval '1 day') d WHERE end_at>=start_at;
$$;
CREATE OR REPLACE VIEW gallabox_private.reply_turns WITH (security_invoker=true) AS
WITH source AS (
 SELECT id,body,body->>'conversationId' conversation_id,(body->>'sentAt')::timestamptz at,
 body->>'authorType'='customer' incoming,body->>'authorType'='staff' human,
 body->>'authorType'='system' AND body#>>'{sourceMetadata,systemEvent,action}' IN ('resolve','close') closed,
 body->>'authorType'='staff' OR (body->>'authorType'='system' AND body#>>'{sourceMetadata,systemEvent,action}' IN ('resolve','close','re-open','initiate')) boundary,
 body->>'authorType'='unknown' AND body#>>'{sourceMetadata,direction}'='outgoing'
 AND trim(both '_' FROM COALESCE(body->>'text','')) <> 'Thanks so much for reaching out! We''re currently outside our working hours (8:00 AM - 5:00 PM) but we''ll get back to you first thing once we''re back online. Talk soon!' uncertain
 FROM gallabox_private.inbox_record WHERE kind='servicemessages' AND body->>'source'='gallabox'
 AND body->>'authorType'<>'bot' AND COALESCE(body->>'internalNote','false')<>'true'
 AND COALESCE(body#>>'{sourceMetadata,nativeContent,kind}','')<>'reaction'
), numbered AS (
 SELECT *,sum(COALESCE(boundary,false)::int) OVER(PARTITION BY conversation_id ORDER BY at,id ROWS UNBOUNDED PRECEDING)-COALESCE(boundary,false)::int turn FROM source
), turns AS (
 SELECT conversation_id,turn,min(at) FILTER(WHERE incoming) started_at,min(at) FILTER(WHERE human) replied_at,
 count(*) FILTER(WHERE incoming)::int customer_messages,max(body->>'externalAuthorId') FILTER(WHERE human) agent_id,
 max(body->>'authorName') FILTER(WHERE human) agent_name,bool_or(COALESCE(uncertain,false)) uncertain_author,
 min(at) FILTER(WHERE closed) closed_at FROM numbered GROUP BY conversation_id,turn
)
SELECT conversation_id,turn,started_at,replied_at,customer_messages,agent_id,agent_name,uncertain_author,
extract(epoch FROM replied_at-started_at)::double precision elapsed_seconds,closed_at FROM turns WHERE started_at IS NOT NULL;
-- Only the derived cache is replaced. The underlying source is immutable here.
DROP MATERIALIZED VIEW gallabox_private.reply_turn_metrics;
CREATE MATERIALIZED VIEW gallabox_private.reply_turn_metrics AS
SELECT t.*,gallabox_private.business_seconds(t.started_at,t.replied_at) business_seconds,statement_timestamp() measured_at FROM gallabox_private.reply_turns t;
CREATE UNIQUE INDEX reply_turn_metrics_identity ON gallabox_private.reply_turn_metrics(conversation_id,turn);
CREATE INDEX reply_turn_metrics_started ON gallabox_private.reply_turn_metrics(started_at);
CREATE MATERIALIZED VIEW gallabox_private.history_coverage AS
SELECT body->>'source' source,count(*) records,min(body->>'sentAt') oldest,max(body->>'sentAt') newest,
count(*) FILTER(WHERE body->>'authorType'='unknown') unknown_authors,statement_timestamp() measured_at
FROM gallabox_private.inbox_record WHERE kind='servicemessages' GROUP BY 1;
CREATE UNIQUE INDEX history_coverage_source ON gallabox_private.history_coverage(source);
REVOKE ALL ON gallabox_private.reply_turn_metrics,gallabox_private.history_coverage FROM PUBLIC,anon,authenticated;
