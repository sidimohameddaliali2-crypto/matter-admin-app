import {cloudInbox,cloudSqlText as lit} from './customerServiceCloudStore.js';
import {captureRange} from './customerServiceCaptureFormat.js';
export async function getServiceMetrics(filters={}){
 const cloud=cloudInbox();if(!cloud)throw Object.assign(new Error('Metrics require the cloud inbox.'),{statusCode:503});
 const range=captureRange(filters),conditions=[];
 if(range.from)conditions.push(`t.started_at>=${lit(range.from.toISOString())}::timestamptz AND t.started_at<${lit(range.to.toISOString())}::timestamptz`);
 if(filters.q)conditions.push(`EXISTS(SELECT 1 FROM gallabox_private.inbox_record c WHERE c.kind='serviceconversations' AND c.id=t.conversation_id AND position(${lit(String(filters.q).toLowerCase().slice(0,200))} in lower(COALESCE(c.body->>'customerName',''))) > 0)`);
 if(filters.categoryId)conditions.push(`EXISTS(SELECT 1 FROM gallabox_private.inbox_record i WHERE i.kind='serviceissues' AND i.body->>'conversationId'=t.conversation_id AND i.body->'categoryIds' ? ${lit(filters.categoryId)})`);
 const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
 const result=await cloud.store.query(`WITH selected AS (SELECT t.* FROM gallabox_private.reply_turn_metrics t ${where}),
 answered AS (SELECT * FROM selected WHERE replied_at IS NOT NULL AND NOT uncertain_author AND elapsed_seconds>=0),
 first_turn AS (SELECT DISTINCT ON(conversation_id) * FROM selected ORDER BY conversation_id,started_at),
 agents AS (SELECT agent_id,MAX(agent_name) name,count(*) replies,avg(business_seconds) average_seconds,percentile_cont(.5) within group(order by business_seconds) median_seconds,percentile_cont(.9) within group(order by business_seconds) p90_seconds,avg(business_seconds) business_average_seconds FROM answered GROUP BY agent_id),
 backlog AS (SELECT DISTINCT ON(body->>'scope',body#>>'{sourceMetadata,externalContactId}') body#>'{sourceMetadata,providerInbox}' state FROM gallabox_private.inbox_record WHERE kind='serviceconversations' AND body->>'source'='gallabox' ORDER BY body->>'scope',body#>>'{sourceMetadata,externalContactId}',body#>>'{sourceMetadata,providerInbox,observedAt}' DESC NULLS LAST),
 latest_turn AS(SELECT DISTINCT ON(conversation_id) * FROM gallabox_private.reply_turn_metrics ORDER BY conversation_id,started_at DESC),
 waiting AS(SELECT t.* FROM latest_turn t JOIN gallabox_private.inbox_record c ON c.kind='serviceconversations' AND c.id=t.conversation_id WHERE t.replied_at IS NULL AND t.closed_at IS NULL AND NOT t.uncertain_author AND c.body#>>'{sourceMetadata,providerInbox,status}'='open' AND c.body->>'externalConversationId'=c.body#>>'{sourceMetadata,providerInbox,externalConversationId}'),
 capture_lag AS(SELECT extract(epoch from (body#>>'{sourceMetadata,capture,capturedAt}')::timestamptz-(body->>'sentAt')::timestamptz) seconds FROM gallabox_private.inbox_record WHERE kind='servicemessages' AND body#>>'{sourceMetadata,capture,worker}'='supabase' AND body#>>'{sourceMetadata,capture,lane}'='live' AND (body->>'sentAt')::timestamptz>=(SELECT min(started_at) FROM gallabox_private.worker_run)),
 runs AS(SELECT * FROM gallabox_private.worker_run ORDER BY started_at DESC LIMIT 100)
 SELECT jsonb_build_object(
 'asOf',now(),'responseMetricsAsOf',(SELECT max(measured_at) FROM gallabox_private.reply_turn_metrics),'answeredTurns',(SELECT count(*) FROM answered),'customerTurns',(SELECT count(*) FROM selected),
 'unansweredTurns',(SELECT count(*) FROM waiting),'closedWithoutReply',(SELECT count(*) FROM selected WHERE replied_at IS NULL AND closed_at IS NOT NULL),
 'uncertainTurns',(SELECT count(*) FROM selected WHERE uncertain_author),
 'averageSeconds',(SELECT avg(business_seconds) FROM answered),'elapsedAverageSeconds',(SELECT avg(elapsed_seconds) FROM answered),'medianSeconds',(SELECT percentile_cont(.5) within group(order by business_seconds) FROM answered),'p90Seconds',(SELECT percentile_cont(.9) within group(order by business_seconds) FROM answered),
 'businessAverageSeconds',(SELECT avg(business_seconds) FROM answered),
 'firstObservedReplyAverageSeconds',(SELECT avg(business_seconds) FROM first_turn WHERE replied_at IS NOT NULL AND NOT uncertain_author),
 'oldestUnansweredSeconds',(SELECT max(gallabox_private.business_seconds(started_at,now())) FROM waiting),
 'agents',COALESCE((SELECT jsonb_agg(a ORDER BY replies DESC) FROM agents a),'[]'),
 'backlog',(SELECT jsonb_build_object('open',count(*) FILTER(WHERE state->>'status'='open'),'unassignedOpen',count(*) FILTER(WHERE state->>'status'='open' AND state->>'assignment'='unassigned'),'unknown',count(*) FILTER(WHERE state IS NULL OR state->>'status'='unknown')) FROM backlog),
 'sync',(SELECT jsonb_build_object('enabled',enabled,'mode',writer_mode,'lastSuccessAt',last_success_at,'lastError',last_error,'runs',runs,'providerReads',provider_reads,'insertedMessages',inserted_messages) FROM gallabox_private.worker_control WHERE singleton),
 'performance',(SELECT jsonb_build_object('meanRunMs',avg(duration_ms),'p90RunMs',percentile_cont(.9) within group(order by duration_ms),'failedRuns',count(*) FILTER(WHERE outcome<>'success' AND outcome<>'running')) FROM runs),
 'captureLatency',(SELECT jsonb_build_object('samples',count(*) FILTER(WHERE seconds>=0),'averageSeconds',avg(seconds) FILTER(WHERE seconds>=0),'p90Seconds',percentile_cont(.9) within group(order by seconds) FILTER(WHERE seconds>=0),'invalidClockSamples',count(*) FILTER(WHERE seconds<0)) FROM capture_lag),
 'historyCoverage',(SELECT jsonb_agg(h) FROM gallabox_private.history_coverage h),
 'captureQueue',(SELECT jsonb_build_object('livePending',count(*) FILTER(WHERE lane='live' AND pending),'historyPending',count(*) FILTER(WHERE lane='history' AND pending),'historyTotal',count(*) FILTER(WHERE lane='history'),'historyChecked',count(*) FILTER(WHERE lane='history' AND last_success_at IS NOT NULL),'historyExhausted',count(*) FILTER(WHERE lane='history' AND NOT pending),'historyPagesAdvanced',COALESCE(sum(page-1) FILTER(WHERE lane='history'),0),'failed',count(*) FILTER(WHERE error IS NOT NULL)) FROM gallabox_private.worker_job)
 );`,{timeoutMs:60000});
 return {...result,workflowStorage:cloud.workflow?'supabase':'local_cache',schedule:'Working time only · 08:00–17:00 Dubai daily. No days off or holidays configured.',definition:'A customer turn begins with the first incoming message after the previous human reply or conversation boundary. Closing or reopening a chat ends the previous wait. Consecutive incoming messages share one wait. Bots, internal notes and reactions are excluded. Unverified outgoing authors are reported separately.',coverage:'Captured native messages only; partial source history. A reply or a Gallabox closure does not prove the customer’s issue was resolved.',backlogScope:'Open · customer last is current backlog across all dates; resolved chats are excluded. It is not a missed-response or SLA-breach count.'};
}
