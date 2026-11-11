CREATE FUNCTION gallabox_private.business_seconds(start_at timestamptz,end_at timestamptz)
RETURNS double precision LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT COALESCE(sum(GREATEST(0,extract(epoch FROM LEAST(end_at,(d::date+CASE WHEN extract(isodow FROM d)<=4 THEN time '17:00' ELSE time '18:00' END) AT TIME ZONE 'Asia/Dubai') - GREATEST(start_at,(d::date+CASE WHEN extract(isodow FROM d)<=4 THEN time '08:00' ELSE time '09:00' END) AT TIME ZONE 'Asia/Dubai')))),0)::double precision
 FROM generate_series((start_at AT TIME ZONE 'Asia/Dubai')::date::timestamp,(end_at AT TIME ZONE 'Asia/Dubai')::date::timestamp,interval '1 day') d
 WHERE end_at>=start_at;
$$;
REVOKE ALL ON FUNCTION gallabox_private.business_seconds(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
CREATE VIEW gallabox_private.reply_turns WITH (security_invoker=true) AS
WITH source AS (
 SELECT id,body,body->>'conversationId' conversation_id,(body->>'sentAt')::timestamptz at,
 body->>'authorType'='customer' incoming,
 body->>'authorType'='staff' human,
 body->>'authorType'='unknown' AND body#>>'{sourceMetadata,direction}'='outgoing'
 AND trim(both '_' FROM COALESCE(body->>'text','')) <> 'Thanks so much for reaching out! We''re currently outside our working hours (8:00 AM - 5:00 PM) but we''ll get back to you first thing once we''re back online. Talk soon!' uncertain
 FROM gallabox_private.inbox_record
 WHERE kind='servicemessages' AND body->>'source'='gallabox'
 AND body->>'authorType' NOT IN ('system','bot')
 AND COALESCE(body->>'internalNote','false')<>'true'
 AND COALESCE(body#>>'{sourceMetadata,nativeContent,kind}','')<>'reaction'
), numbered AS (
 SELECT *,sum(human::int) OVER(PARTITION BY conversation_id ORDER BY at,id ROWS UNBOUNDED PRECEDING)-human::int turn FROM source
), turns AS (
 SELECT conversation_id,turn,min(at) FILTER(WHERE incoming) started_at,
 min(at) FILTER(WHERE human) replied_at, count(*) FILTER(WHERE incoming)::int customer_messages,
 max(body->>'externalAuthorId') FILTER(WHERE human) agent_id,
 max(body->>'authorName') FILTER(WHERE human) agent_name,
 bool_or(uncertain) uncertain_author
 FROM numbered GROUP BY conversation_id,turn
)
SELECT *,extract(epoch FROM replied_at-started_at)::double precision elapsed_seconds
FROM turns WHERE started_at IS NOT NULL;
REVOKE ALL ON gallabox_private.reply_turns FROM PUBLIC,anon,authenticated;
