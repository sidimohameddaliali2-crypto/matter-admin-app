-- Generated with `supabase migration new`; reviewed separately before application.
-- Additive Sidi host metadata only. Original evidence, financial ledgers,
-- collector state, receipts, reviews, lease functions and ACLs remain untouched.
BEGIN;

DO $original_lease_contract$
DECLARE item record;
BEGIN
  IF to_regclass('matter_reporting_hosted.collector_lease') IS NULL THEN
    RAISE EXCEPTION 'The original collector lease is required';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('matter_reporting_hosted.lease_acquire(uuid,integer)', '8f494044d86b892a925fd3c8c6fa9eb59b457f823bea7da1e04b935916ca0e70'),
    ('matter_reporting_hosted.lease_assert(uuid,bigint)', 'bd84e8d431d8ecf16a75ccd319d3f4872626bcac61bde5f851b9a27c1f20db48'),
    ('matter_reporting_hosted.lease_release(uuid,bigint)', '506de18f435ccefcbd1fb32917df06c0a7572017e206f680044afc0a6fbe0b98'),
    ('matter_reporting_hosted.collector_cas(uuid,bigint,bigint,text,text,text,text)', '1824ad8b7e7c1d2552a2203e18ca2910d96fe0671ff7c038891600fdc3c46ccc')
  ) expected(signature, sha256) LOOP
    IF encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(item.signature)), 'UTF8')), 'hex') IS DISTINCT FROM item.sha256 THEN
      RAISE EXCEPTION 'The original collector lease contract differs';
    END IF;
  END LOOP;
END $original_lease_contract$;

CREATE SCHEMA matter_reporting_app AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA matter_reporting_app FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE matter_reporting_app.progress (
  key text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  body_text text NOT NULL CHECK (octet_length(body_text) <= 1048576),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE matter_reporting_app.progress_retry (
  key text NOT NULL REFERENCES matter_reporting_app.progress(key),
  event_id text NOT NULL,
  revision bigint NOT NULL,
  request_sha256 text NOT NULL,
  body_text text NOT NULL,
  event_text text NOT NULL,
  body_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (key, event_id)
);
CREATE INDEX progress_retry_age ON matter_reporting_app.progress_retry(created_at);
CREATE TABLE matter_reporting_app.photo_alias_store (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE matter_reporting_app.photo_alias (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}\.gz$'),
  reference jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE matter_reporting_app.photo_alias_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  rows bigint NOT NULL CHECK (rows BETWEEN 0 AND 200000),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 0 AND 134217728)
);
INSERT INTO matter_reporting_app.photo_alias_capacity VALUES (true, 0, 0);

-- These are explicit application operating caps, not a claim about the
-- Supabase subscription, provider invoice or remaining included transfer.
CREATE TABLE matter_reporting_app.egress_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version text NOT NULL CHECK (version = 'supabase-http-bytes-v1'),
  month_limit bigint NOT NULL CHECK (month_limit = 8589934592),
  day_limit bigint NOT NULL CHECK (day_limit = 536870912),
  latest_day date
);
INSERT INTO matter_reporting_app.egress_policy(singleton, version, month_limit, day_limit)
VALUES (true, 'supabase-http-bytes-v1', 8589934592, 536870912);
CREATE TABLE matter_reporting_app.egress_counter (
  kind text NOT NULL CHECK (kind IN ('month', 'day')),
  period date NOT NULL,
  used_bytes bigint NOT NULL CHECK (used_bytes >= 0),
  uncertain_reservations bigint NOT NULL DEFAULT 0 CHECK (uncertain_reservations >= 0),
  PRIMARY KEY (kind, period)
);
CREATE TABLE matter_reporting_app.egress_retry (
  id uuid PRIMARY KEY,
  month_period date NOT NULL,
  day_period date NOT NULL,
  request_bytes bigint NOT NULL,
  response_bytes bigint NOT NULL,
  started_at timestamptz NOT NULL,
  settled_at timestamptz,
  actual_request_bytes bigint,
  actual_response_bytes bigint
);
CREATE INDEX egress_retry_age ON matter_reporting_app.egress_retry(started_at);

ALTER TABLE matter_reporting_app.progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.progress_retry ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.photo_alias_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.photo_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.photo_alias_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.egress_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.egress_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE matter_reporting_app.egress_retry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA matter_reporting_app FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION matter_reporting_app.valid_key(p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT p_key IS NOT NULL AND p_key ~ '^(native-progress:delivery|native-progress:gps:[a-zA-Z0-9_-]{1,60})$'
$fn$;

-- JSONB would silently discard duplicate properties. This compact round trip
-- preserves input property order and rejects duplicates before JSONB validation.
CREATE FUNCTION matter_reporting_app.compact_json(p_value json, p_depth integer DEFAULT 0) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog SET extra_float_digits = 3 AS $fn$
DECLARE kind text := json_typeof(p_value); result text; number_value double precision;
BEGIN
  IF p_depth > 12 THEN RAISE EXCEPTION 'Progress JSON nesting exceeds its bound'; END IF;
  IF kind = 'object' THEN
    IF (SELECT count(*) <> count(DISTINCT key) FROM json_each(p_value)) THEN RAISE EXCEPTION 'Duplicate progress property'; END IF;
    SELECT '{' || COALESCE(string_agg(to_json(key)::text || ':' || matter_reporting_app.compact_json(value, p_depth + 1), ',' ORDER BY n), '') || '}'
      INTO result FROM json_each(p_value) WITH ORDINALITY AS entries(key, value, n);
  ELSIF kind = 'array' THEN
    SELECT '[' || COALESCE(string_agg(matter_reporting_app.compact_json(value, p_depth + 1), ',' ORDER BY n), '') || ']'
      INTO result FROM json_array_elements(p_value) WITH ORDINALITY AS entries(value, n);
  ELSIF kind = 'string' THEN result := to_json(p_value #>> '{}')::text;
  ELSIF kind = 'number' THEN
    number_value := p_value::text::double precision;
    IF number_value >= 'Infinity'::double precision OR number_value <= '-Infinity'::double precision THEN RAISE EXCEPTION 'Invalid progress number'; END IF;
    IF number_value = 0 THEN result := '0';
    ELSIF abs(number_value) >= 0.000001 AND abs(number_value) < 1e21 THEN result := trim_scale(number_value::text::numeric)::text;
    ELSE result := regexp_replace(number_value::text, 'e([+-])0+([0-9]+)$', E'e\\1\\2'); END IF;
  ELSE result := p_value::text;
  END IF;
  RETURN result;
END $fn$;

CREATE FUNCTION matter_reporting_app.valid_scalar(p_value jsonb, p_kind text, p_limit integer DEFAULT 0) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
DECLARE value text := p_value #>> '{}'; numeric_value numeric; date_value date; stamp timestamptz;
BEGIN
  IF p_kind = 'null' THEN RETURN p_value = 'null'::jsonb; END IF;
  IF p_kind = 'boolean' THEN RETURN jsonb_typeof(p_value) = 'boolean'; END IF;
  IF p_kind IN ('integer', 'epoch', 'httpStatus') THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    numeric_value := value::numeric;
    RETURN numeric_value >= 0 AND CASE WHEN p_kind = 'integer' THEN numeric_value <= 9007199254740991 AND trunc(numeric_value) = numeric_value
      WHEN p_kind = 'httpStatus' THEN numeric_value BETWEEN 100 AND 599 AND trunc(numeric_value) = numeric_value
      ELSE numeric_value::double precision < 'Infinity'::double precision END;
  END IF;
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  CASE p_kind
    WHEN 'digest' THEN RETURN value ~ '^[a-f0-9]{64}$';
    WHEN 'driver' THEN RETURN value ~ '^[a-f0-9]{24}$';
    WHEN 'windowKey' THEN RETURN value ~ '^[a-f0-9]{24}/[0-9]{4}-[0-9]{2}-[0-9]{2}$';
    WHEN 'run' THEN RETURN value ~ '^stream-[0-9]{1,113}$';
    WHEN 'day' THEN
      IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
      date_value := value::date; RETURN to_char(date_value, 'YYYY-MM-DD') = value;
    WHEN 'timestamp' THEN
      IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
      stamp := value::timestamptz; RETURN isfinite(stamp);
    WHEN 'text' THEN
      RETURN char_length(value) + regexp_count(value, '[' || chr(65536) || '-' || chr(1114111) || ']') <= p_limit
        AND btrim(value, ' ' || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
          || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)) <> ''
        AND value !~ U&'[\0001-\001F\007F]';
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

CREATE FUNCTION matter_reporting_app.matches_schema(p_value jsonb, p_schema jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
DECLARE item record; candidate jsonb; kind text := p_schema ->> 'type';
BEGIN
  IF kind = 'oneOf' THEN
    FOR candidate IN SELECT value FROM jsonb_array_elements(p_schema -> 'options') LOOP
      IF matter_reporting_app.matches_schema(p_value, candidate) THEN RETURN true; END IF;
    END LOOP; RETURN false;
  ELSIF kind = 'enum' THEN RETURN (p_schema -> 'values') @> jsonb_build_array(p_value);
  ELSIF kind = 'array' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR jsonb_array_length(p_value) > (p_schema ->> 'max')::integer THEN RETURN false; END IF;
    FOR candidate IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF NOT matter_reporting_app.matches_schema(candidate, p_schema -> 'items') THEN RETURN false; END IF;
    END LOOP; RETURN true;
  ELSIF kind = 'record' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_value)) > (p_schema ->> 'max')::integer THEN RETURN false; END IF;
    FOR item IN SELECT key, value FROM jsonb_each(p_value) LOOP
      IF NOT matter_reporting_app.valid_scalar(to_jsonb(item.key), p_schema ->> 'key')
        OR NOT matter_reporting_app.matches_schema(item.value, p_schema -> 'items') THEN RETURN false; END IF;
    END LOOP; RETURN true;
  ELSIF kind = 'object' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_schema -> 'required') k WHERE NOT p_value ? k) THEN RETURN false; END IF;
    FOR item IN SELECT key, value FROM jsonb_each(p_value) LOOP
      candidate := COALESCE(p_schema -> 'required' -> item.key, p_schema -> 'optional' -> item.key);
      IF candidate IS NULL OR NOT matter_reporting_app.matches_schema(item.value, candidate) THEN RETURN false; END IF;
    END LOOP; RETURN true;
  END IF;
  RETURN matter_reporting_app.valid_scalar(p_value, kind, COALESCE((p_schema ->> 'max')::integer, 0));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

CREATE FUNCTION matter_reporting_app.progress_schema(p_gps boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN p_gps THEN $gps_schema${"type":"object","required":{"version":{"type":"enum","values":[1]},"kind":{"type":"enum","values":["native-gps-poll-progress"]},"lastPoll":{"type":"oneOf","options":[{"type":"null"},{"type":"object","required":{"driverId":{"type":"driver"},"day":{"type":"day"},"startedAt":{"type":"timestamp"},"status":{"type":"enum","values":["started","complete","failed"]}},"optional":{"completedAt":{"type":"timestamp"},"unchanged":{"type":"boolean"},"dataSnapshotSha256":{"type":"digest"}}}]},"lastSuccessfulPollAt":{"type":"oneOf","options":[{"type":"null"},{"type":"timestamp"}]},"lastDataChangeAt":{"type":"oneOf","options":[{"type":"null"},{"type":"timestamp"}]},"namespace":{"type":"text","max":60},"turn":{"type":"integer"},"windows":{"type":"record","key":"windowKey","items":{"type":"object","required":{"driverId":{"type":"driver"},"day":{"type":"day"}},"optional":{"scopeKind":{"type":"enum","values":["driver","vehicle"]},"vehicleNo":{"type":"text","max":128},"rosterReferenceDriverId":{"type":"driver"},"lastAttemptAt":{"type":"timestamp"},"retryAt":{"type":"oneOf","options":[{"type":"null"},{"type":"epoch"}]},"failures":{"type":"integer"},"error":{"type":"oneOf","options":[{"type":"null"},{"type":"object","required":{"at":{"type":"timestamp"},"category":{"type":"enum","values":["http","schema","pagination","response_limit","capacity","timeout","read_failed"]},"httpStatus":{"type":"oneOf","options":[{"type":"null"},{"type":"httpStatus"}]},"message":{"type":"enum","values":["Saved GPS refresh failed; previously verified history is retained"]}},"optional":{}}]},"lastSuccessfulPollAt":{"type":"timestamp"},"refreshToken":{"type":"text","max":128}}},"max":700}},"optional":{}}$gps_schema$::jsonb ELSE $delivery_schema${"type":"object","required":{"version":{"type":"enum","values":[1]},"kind":{"type":"enum","values":["native-delivery-poll-progress"]},"lastPoll":{"type":"oneOf","options":[{"type":"null"},{"type":"object","required":{"runId":{"type":"run"},"day":{"type":"day"},"startedAt":{"type":"timestamp"},"status":{"type":"enum","values":["started","complete","failed"]}},"optional":{"completedAt":{"type":"timestamp"},"unchanged":{"type":"boolean"},"captureRunId":{"type":"run"},"captureSha256":{"type":"digest"},"lastDataChangeAt":{"type":"oneOf","options":[{"type":"null"},{"type":"timestamp"}]},"errorCode":{"type":"enum","values":["capture-not-published"]}}}]},"lastSuccessfulPollAt":{"type":"oneOf","options":[{"type":"null"},{"type":"timestamp"}]},"lastDataChangeAt":{"type":"oneOf","options":[{"type":"null"},{"type":"timestamp"}]},"schedule":{"type":"object","required":{"pending":{"type":"array","items":{"type":"object","required":{"day":{"type":"day"},"runId":{"type":"run"}},"optional":{"final":{"type":"boolean"},"fresh":{"type":"boolean"},"sourceStarted":{"type":"boolean"},"attempts":{"type":"integer"},"nextAttempt":{"type":"epoch"},"lastFailure":{"type":"oneOf","options":[{"type":"object","required":{"code":{"type":"enum","values":["capture-not-published"]}},"optional":{}},{"type":"object","required":{"runId":{"type":"run"},"day":{"type":"day"},"message":{"type":"text","max":200}},"optional":{}}]},"nativeCaptureRunId":{"type":"run"},"nativeCaptureSha256":{"type":"digest"},"reason":{"type":"text","max":200}}},"max":4096}},"optional":{"migrationPendingHistory":{"type":"array","items":{"type":"object","required":{"day":{"type":"day"},"runId":{"type":"run"}},"optional":{"final":{"type":"boolean"},"fresh":{"type":"boolean"},"sourceStarted":{"type":"boolean"},"attempts":{"type":"integer"},"nextAttempt":{"type":"epoch"},"lastFailure":{"type":"oneOf","options":[{"type":"object","required":{"code":{"type":"enum","values":["capture-not-published"]}},"optional":{}},{"type":"object","required":{"runId":{"type":"run"},"day":{"type":"day"},"message":{"type":"text","max":200}},"optional":{}}]},"nativeCaptureRunId":{"type":"run"},"nativeCaptureSha256":{"type":"digest"},"reason":{"type":"text","max":200}}},"max":4096},"lastDay":{"type":"day"},"sourceAttempts":{"type":"record","key":"day","items":{"type":"epoch"},"max":4096},"lastAttempts":{"type":"record","key":"day","items":{"type":"epoch"},"max":4096},"observations":{"type":"record","key":"day","items":{"type":"epoch"},"max":4096},"gaps":{"type":"array","items":{"type":"object","required":{"reason":{"type":"text","max":200}},"optional":{"from":{"type":"day"},"to":{"type":"day"},"count":{"type":"integer"},"limit":{"type":"integer"}}},"max":4096},"sourceHalt":{"type":"oneOf","options":[{"type":"null"},{"type":"object","required":{"code":{"type":"enum","values":["source_rate_limit","source_denied"]},"at":{"type":"timestamp"}},"optional":{}}]},"photoSourceHalt":{"type":"oneOf","options":[{"type":"null"},{"type":"object","required":{"status":{"type":"enum","values":[401,403,429]},"at":{"type":"timestamp"}},"optional":{}}]},"migrationCheckpointSha256":{"type":"digest"}}},"photoCursor":{"type":"integer"},"photoSourceHalt":{"type":"oneOf","options":[{"type":"null"},{"type":"object","required":{"status":{"type":"enum","values":[401,403,429]},"at":{"type":"timestamp"}},"optional":{}}]}},"optional":{}}$delivery_schema$::jsonb END
$fn$;

CREATE FUNCTION matter_reporting_app.validate_progress(p_key text, p_body text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
DECLARE body_value jsonb; item jsonb; entry record; gps boolean := p_key <> 'native-progress:delivery';
BEGIN
  IF NOT matter_reporting_app.valid_key(p_key) OR p_body IS NULL OR octet_length(p_body) > 1048576
    OR p_body IS DISTINCT FROM matter_reporting_app.compact_json(p_body::json)
    OR NOT matter_reporting_app.matches_schema(p_body::jsonb, matter_reporting_app.progress_schema(gps)) THEN
    RAISE EXCEPTION 'Invalid bounded app polling progress' USING ERRCODE = '22023';
  END IF;
  body_value := p_body::jsonb;
  IF gps THEN
    IF body_value ->> 'namespace' IS DISTINCT FROM substr(p_key, length('native-progress:gps:') + 1) THEN RAISE EXCEPTION 'GPS progress namespace differs'; END IF;
    FOR entry IN SELECT key, value FROM jsonb_each(body_value -> 'windows') LOOP
      IF entry.key IS DISTINCT FROM (entry.value ->> 'driverId') || '/' || (entry.value ->> 'day') THEN RAISE EXCEPTION 'GPS progress window identity differs'; END IF;
    END LOOP;
  ELSE
    FOR item IN SELECT x FROM jsonb_array_elements((body_value #> '{schedule,pending}') || COALESCE(body_value #> '{schedule,migrationPendingHistory}', '[]'::jsonb)) x LOOP
      IF (item ? 'nativeCaptureRunId') <> (item ? 'nativeCaptureSha256') THEN RAISE EXCEPTION 'Progress capture identity differs'; END IF;
    END LOOP;
    IF body_value -> 'lastPoll' <> 'null'::jsonb AND ((body_value -> 'lastPoll' ? 'captureRunId') <> (body_value -> 'lastPoll' ? 'captureSha256')) THEN RAISE EXCEPTION 'Progress capture identity differs'; END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid bounded app polling progress' USING ERRCODE = '22023';
END $fn$;

CREATE FUNCTION public.matter_hosted_app_progress_read(p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE current_row matter_reporting_app.progress%ROWTYPE;
BEGIN
  IF NOT matter_reporting_app.valid_key(p_key) THEN RAISE EXCEPTION 'Invalid progress key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO current_row FROM matter_reporting_app.progress WHERE key = p_key;
  IF FOUND THEN PERFORM matter_reporting_app.validate_progress(p_key, current_row.body_text); END IF;
  RETURN jsonb_build_object('revision', COALESCE(current_row.revision, 0), 'body_text', current_row.body_text);
END $fn$;

CREATE FUNCTION public.matter_hosted_app_progress_cas(p_key text, p_owner uuid, p_token bigint, p_expected bigint,
  p_event_id text, p_body_text text, p_event_text text, p_request_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE current_row matter_reporting_app.progress%ROWTYPE; prior matter_reporting_app.progress_retry%ROWTYPE;
  digest text; phase text; expected_event text; expected_request text; request_digest text; allocated bigint;
BEGIN
  PERFORM matter_reporting_app.validate_progress(p_key, p_body_text);
  IF p_owner IS NULL OR p_token IS NULL OR p_token < 1 OR p_token > 9007199254740991 OR p_expected IS NULL OR p_expected < 0 OR p_expected >= 9007199254740991
    OR p_event_text IS NULL OR octet_length(p_event_text) > 1024 OR p_request_text IS NULL OR octet_length(p_request_text) > 1024 THEN
    RAISE EXCEPTION 'Invalid app progress request' USING ERRCODE = '22023';
  END IF;
  digest := encode(sha256(convert_to(p_body_text, 'UTF8')), 'hex'); phase := p_event_text::jsonb ->> 'phase';
  expected_event := '{"kind":"native-poll-progress","key":' || to_json(p_key)::text || ',"phase":' || to_json(phase)::text || ',"bodySha256":"' || digest || '"}';
  expected_request := '{"key":' || to_json(p_key)::text || ',"expectedRevision":' || p_expected::text || ',"bodySha256":"' || digest || '"}';
  IF phase IS NULL OR phase NOT IN ('started', 'settled', 'schedule', 'failure') OR p_event_text IS DISTINCT FROM expected_event OR p_request_text IS DISTINCT FROM expected_request
    OR p_event_id IS DISTINCT FROM 'progress-' || encode(sha256(convert_to('[' || to_json(p_key)::text || ',' || p_expected::text || ',"' || digest || '"]', 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'App progress request identity differs' USING ERRCODE = '22023';
  END IF;
  -- Exact lock shared by the preserved acquire/release/collector CAS functions.
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_hosted/lease/collector', 0));
  IF NOT matter_reporting_hosted.lease_assert(p_owner, p_token) THEN RAISE EXCEPTION 'Collector lease expired or superseded' USING ERRCODE = 'PT409'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_app/progress-capacity', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_app/progress/' || p_key, 0));
  DELETE FROM matter_reporting_app.progress_retry WHERE created_at <= clock_timestamp() - interval '15 minutes';
  request_digest := encode(sha256(convert_to(p_key || E'\n' || p_request_text, 'UTF8')), 'hex');
  SELECT * INTO prior FROM matter_reporting_app.progress_retry WHERE key = p_key AND event_id = p_event_id;
  IF FOUND THEN
    IF prior.request_sha256 <> request_digest OR prior.body_sha256 <> digest OR prior.body_text <> p_body_text OR prior.event_text <> p_event_text THEN RAISE EXCEPTION 'Progress replay conflicts' USING ERRCODE = '23505'; END IF;
    IF NOT matter_reporting_hosted.lease_assert(p_owner, p_token) THEN RAISE EXCEPTION 'Collector lease expired or superseded' USING ERRCODE = 'PT409'; END IF;
    RETURN jsonb_build_object('revision', prior.revision, 'replayed', true, 'event_text', prior.event_text, 'body_text', prior.body_text, 'body_sha256', prior.body_sha256);
  END IF;
  SELECT * INTO current_row FROM matter_reporting_app.progress WHERE key = p_key;
  IF COALESCE(current_row.revision, 0) <> p_expected THEN RAISE EXCEPTION 'Progress revision conflicts' USING ERRCODE = 'PT409'; END IF;
  IF current_row.key IS NULL AND (SELECT count(*) FROM matter_reporting_app.progress) >= 256 THEN RAISE EXCEPTION 'App progress key allowance exhausted' USING ERRCODE = 'PT429'; END IF;
  DELETE FROM matter_reporting_app.progress_retry WHERE key = p_key AND event_id NOT IN
    (SELECT event_id FROM matter_reporting_app.progress_retry WHERE key = p_key ORDER BY revision DESC LIMIT 1);
  INSERT INTO matter_reporting_app.progress(key, revision, body_text) VALUES (p_key, p_expected + 1, p_body_text)
    ON CONFLICT (key) DO UPDATE SET revision = EXCLUDED.revision, body_text = EXCLUDED.body_text, updated_at = clock_timestamp();
  INSERT INTO matter_reporting_app.progress_retry(key, event_id, revision, request_sha256, body_text, event_text, body_sha256)
    VALUES (p_key, p_event_id, p_expected + 1, request_digest, p_body_text, p_event_text, digest);
  SELECT COALESCE((SELECT sum(octet_length(body_text) + 1024) FROM matter_reporting_app.progress), 0)
    + COALESCE((SELECT sum(octet_length(body_text) + octet_length(event_text) + 1024) FROM matter_reporting_app.progress_retry), 0) INTO allocated;
  IF allocated > 67108864 THEN RAISE EXCEPTION 'App progress byte allowance exhausted' USING ERRCODE = 'PT429'; END IF;
  IF NOT matter_reporting_hosted.lease_assert(p_owner, p_token) THEN RAISE EXCEPTION 'Collector lease expired or superseded' USING ERRCODE = 'PT409'; END IF;
  RETURN jsonb_build_object('revision', p_expected + 1, 'replayed', false, 'event_text', p_event_text, 'body_text', p_body_text, 'body_sha256', digest);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Invalid app progress request' USING ERRCODE = '22023';
END $fn$;

CREATE FUNCTION matter_reporting_app.valid_alias(p_key text, p_reference jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
BEGIN
  RETURN p_key ~ '^[a-f0-9]{64}\.gz$' AND jsonb_typeof(p_reference) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(p_reference)) = 9
    AND p_reference ?& ARRAY['version','provider','identitySha256','key','size','sha256','kind','etag','versionId']
    AND p_reference -> 'version' = '1'::jsonb AND p_reference ->> 'provider' = 'spaces' AND p_reference ->> 'kind' = 'existing-photo-v1'
    AND jsonb_typeof(p_reference -> 'identitySha256') = 'string' AND p_reference ->> 'identitySha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(p_reference -> 'sha256') = 'string' AND p_reference ->> 'sha256' = left(p_key, 64)
    AND jsonb_typeof(p_reference -> 'key') = 'string' AND p_reference ->> 'key' ~ '^photos/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
    AND jsonb_typeof(p_reference -> 'size') = 'number' AND (p_reference ->> 'size')::numeric BETWEEN 1 AND 16777216
    AND trunc((p_reference ->> 'size')::numeric) = (p_reference ->> 'size')::numeric
    AND jsonb_typeof(p_reference -> 'etag') = 'string' AND p_reference ->> 'etag' ~ '^"[!-!#-~]{1,200}"$'
    AND (p_reference -> 'versionId' = 'null'::jsonb OR jsonb_typeof(p_reference -> 'versionId') = 'string' AND p_reference ->> 'versionId' ~ '^[A-Za-z0-9._~+/=-]{1,512}$');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

CREATE FUNCTION public.matter_hosted_app_photo_alias_read(p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE result jsonb; identity text;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}\.gz$' THEN RAISE EXCEPTION 'Invalid photo alias key' USING ERRCODE = '22023'; END IF;
  SELECT reference INTO result FROM matter_reporting_app.photo_alias WHERE key = p_key;
  IF result IS NOT NULL THEN
    SELECT identity_sha256 INTO identity FROM matter_reporting_app.photo_alias_store WHERE singleton;
    IF NOT COALESCE(matter_reporting_app.valid_alias(p_key, result), false) OR identity IS DISTINCT FROM result ->> 'identitySha256' THEN
      RAISE EXCEPTION 'Admitted photo alias metadata or destination differs' USING ERRCODE = 'PT409';
    END IF;
  END IF;
  RETURN jsonb_build_object('reference', result);
END $fn$;

CREATE FUNCTION public.matter_hosted_app_photo_alias_register(p_key text, p_reference jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE existing jsonb; identity text; allocation matter_reporting_app.photo_alias_capacity%ROWTYPE; charge bigint;
BEGIN
  IF NOT COALESCE(matter_reporting_app.valid_alias(p_key, p_reference), false) THEN RAISE EXCEPTION 'Invalid immutable photo alias' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_app/photo-alias-capacity', 0));
  SELECT identity_sha256 INTO identity FROM matter_reporting_app.photo_alias_store WHERE singleton;
  IF identity IS NOT NULL AND identity <> p_reference ->> 'identitySha256' THEN RAISE EXCEPTION 'Photo alias destination differs' USING ERRCODE = 'PT409'; END IF;
  SELECT reference INTO existing FROM matter_reporting_app.photo_alias WHERE key = p_key;
  IF existing IS NOT NULL THEN
    IF NOT COALESCE(matter_reporting_app.valid_alias(p_key, existing), false) OR identity IS DISTINCT FROM existing ->> 'identitySha256'
      OR existing ->> 'sha256' <> p_reference ->> 'sha256' OR existing -> 'size' <> p_reference -> 'size' THEN RAISE EXCEPTION 'Photo alias identity differs' USING ERRCODE = 'PT409'; END IF;
    RETURN jsonb_build_object('reference', existing);
  END IF;
  SELECT * INTO allocation FROM matter_reporting_app.photo_alias_capacity WHERE singleton;
  charge := pg_column_size(p_reference)::bigint + 1024;
  IF allocation.singleton IS NULL OR allocation.rows >= 200000 OR allocation.bytes + charge > 134217728 THEN
    RAISE EXCEPTION 'Photo alias metadata allowance exhausted' USING ERRCODE = 'PT429';
  END IF;
  IF identity IS NULL THEN INSERT INTO matter_reporting_app.photo_alias_store(singleton, identity_sha256) VALUES (true, p_reference ->> 'identitySha256'); END IF;
  INSERT INTO matter_reporting_app.photo_alias(key, reference) VALUES (p_key, p_reference);
  UPDATE matter_reporting_app.photo_alias_capacity SET rows = rows + 1, bytes = bytes + charge WHERE singleton;
  RETURN jsonb_build_object('reference', p_reference);
END $fn$;

CREATE FUNCTION matter_reporting_app.deny_alias_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'Admitted photo alias metadata is immutable'; END $fn$;
CREATE TRIGGER immutable_photo_alias BEFORE UPDATE OR DELETE ON matter_reporting_app.photo_alias
FOR EACH ROW EXECUTE FUNCTION matter_reporting_app.deny_alias_change();
CREATE TRIGGER immutable_photo_alias_store BEFORE UPDATE OR DELETE ON matter_reporting_app.photo_alias_store
FOR EACH ROW EXECUTE FUNCTION matter_reporting_app.deny_alias_change();

CREATE FUNCTION matter_reporting_app.egress_summary(p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE policy matter_reporting_app.egress_policy%ROWTYPE; today date := (p_now AT TIME ZONE 'UTC')::date;
  month_start date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
  month_total bigint; day_total bigint; month_reserved bigint; day_reserved bigint; active_count bigint; uncertain_count bigint;
BEGIN
  SELECT * INTO policy FROM matter_reporting_app.egress_policy WHERE singleton;
  IF policy.version IS DISTINCT FROM 'supabase-http-bytes-v1' OR policy.month_limit IS DISTINCT FROM 8589934592
    OR policy.day_limit IS DISTINCT FROM 536870912 OR policy.latest_day > today THEN
    RAISE EXCEPTION 'The fixed read-egress policy or UTC clock differs' USING ERRCODE = 'PT409';
  END IF;
  SELECT COALESCE(used_bytes, 0) INTO month_total FROM matter_reporting_app.egress_counter WHERE kind = 'month' AND period = month_start;
  SELECT COALESCE(used_bytes, 0) INTO day_total FROM matter_reporting_app.egress_counter WHERE kind = 'day' AND period = today;
  SELECT COALESCE(sum(request_bytes + response_bytes) FILTER (WHERE month_period = month_start), 0),
    COALESCE(sum(request_bytes + response_bytes) FILTER (WHERE day_period = today), 0), count(*)
    INTO month_reserved, day_reserved, active_count FROM matter_reporting_app.egress_retry
    WHERE settled_at IS NULL AND started_at > p_now - interval '15 minutes';
  SELECT COALESCE(sum(uncertain_reservations), 0) INTO uncertain_count FROM matter_reporting_app.egress_counter WHERE kind = 'month';
  uncertain_count := uncertain_count + (SELECT count(*) FROM matter_reporting_app.egress_retry WHERE settled_at IS NULL AND started_at <= p_now - interval '15 minutes');
  month_total := COALESCE(month_total, 0); day_total := COALESCE(day_total, 0);
  IF month_reserved > month_total OR day_reserved > day_total OR month_total > policy.month_limit OR day_total > policy.day_limit OR active_count > 4 THEN
    RAISE EXCEPTION 'Read-egress allocation differs';
  END IF;
  RETURN jsonb_build_object('version', 1, 'basis', policy.version,
    'month', jsonb_build_object('period', to_char(month_start, 'YYYY-MM'), 'usedBytes', month_total - month_reserved, 'reservedBytes', month_reserved, 'limitBytes', policy.month_limit),
    'day', jsonb_build_object('period', to_char(today, 'YYYY-MM-DD'), 'usedBytes', day_total - day_reserved, 'reservedBytes', day_reserved, 'limitBytes', policy.day_limit),
    'activeReservations', active_count, 'uncertainReservations', uncertain_count);
END $fn$;

CREATE FUNCTION matter_reporting_app.prune_egress(p_now timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE old matter_reporting_app.egress_retry%ROWTYPE; today date := (p_now AT TIME ZONE 'UTC')::date;
  month_start date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
BEGIN
  FOR old IN SELECT * FROM matter_reporting_app.egress_retry WHERE started_at <= p_now - interval '15 minutes' LOOP
    -- Free only a slot/retry payload. Worst-case bytes remain charged forever
    -- within their retained monthly/daily aggregate; no timeout refund exists.
    IF old.settled_at IS NULL THEN
      UPDATE matter_reporting_app.egress_counter SET uncertain_reservations = uncertain_reservations + 1
        WHERE (kind = 'month' AND period = old.month_period) OR (kind = 'day' AND period = old.day_period);
    END IF;
    DELETE FROM matter_reporting_app.egress_retry WHERE id = old.id;
  END LOOP;
  DELETE FROM matter_reporting_app.egress_counter
    WHERE (kind = 'month' AND period < (month_start - interval '1 month')::date)
      OR (kind = 'day' AND period < today - 1);
END $fn$;

CREATE FUNCTION public.matter_hosted_app_read_egress_read() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_app/read-egress', 0));
  RETURN matter_reporting_app.egress_summary(clock_timestamp());
END $fn$;

CREATE FUNCTION public.matter_hosted_app_read_egress_reserve(p_id uuid, p_request_bytes bigint, p_response_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE prior matter_reporting_app.egress_retry%ROWTYPE; time_at timestamptz := clock_timestamp(); today date;
  month_start date; summary jsonb; amount bigint; reason text;
BEGIN
  IF p_id IS NULL OR p_request_bytes IS NULL OR p_response_bytes IS NULL OR p_request_bytes < 0 OR p_response_bytes < 0
    OR p_request_bytes > 83886080 OR p_response_bytes > 83886080 THEN RAISE EXCEPTION 'Invalid bounded read-egress request' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_app/read-egress', 0));
  time_at := clock_timestamp(); today := (time_at AT TIME ZONE 'UTC')::date; month_start := date_trunc('month', time_at AT TIME ZONE 'UTC')::date;
  summary := matter_reporting_app.egress_summary(time_at);
  PERFORM matter_reporting_app.prune_egress(time_at);
  SELECT * INTO prior FROM matter_reporting_app.egress_retry WHERE id = p_id;
  IF FOUND THEN
    IF prior.request_bytes <> p_request_bytes OR prior.response_bytes <> p_response_bytes THEN RAISE EXCEPTION 'Read-egress reservation identity conflicts' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1', 'allowed', false, 'replayed', true, 'id', p_id,
      'period', to_char(prior.month_period, 'YYYY-MM'), 'requestBytes', prior.request_bytes, 'responseBytes', prior.response_bytes,
      'reason', CASE WHEN prior.settled_at IS NULL THEN 'already-admitted' ELSE 'already-settled' END, 'summary', matter_reporting_app.egress_summary(time_at));
  END IF;
  amount := p_request_bytes + p_response_bytes + 8192;
  summary := matter_reporting_app.egress_summary(time_at);
  IF (summary ->> 'activeReservations')::bigint >= 4 THEN reason := 'concurrency-limit';
  ELSIF (SELECT count(*) FROM matter_reporting_app.egress_retry) >= 4096 THEN reason := 'retry-capacity';
  ELSIF (summary #>> '{month,usedBytes}')::bigint + (summary #>> '{month,reservedBytes}')::bigint + amount > 8589934592 THEN reason := 'month-byte-limit';
  ELSIF (summary #>> '{day,usedBytes}')::bigint + (summary #>> '{day,reservedBytes}')::bigint + amount > 536870912 THEN reason := 'day-byte-limit'; END IF;
  IF reason IS NOT NULL THEN RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1', 'allowed', false, 'replayed', false,
    'id', p_id, 'period', to_char(month_start, 'YYYY-MM'), 'reason', reason, 'summary', summary); END IF;
  UPDATE matter_reporting_app.egress_policy SET latest_day = today WHERE singleton;
  INSERT INTO matter_reporting_app.egress_counter(kind, period, used_bytes) VALUES ('month', month_start, amount), ('day', today, amount)
    ON CONFLICT (kind, period) DO UPDATE SET used_bytes = matter_reporting_app.egress_counter.used_bytes + EXCLUDED.used_bytes;
  INSERT INTO matter_reporting_app.egress_retry(id, month_period, day_period, request_bytes, response_bytes, started_at)
    VALUES (p_id, month_start, today, p_request_bytes, p_response_bytes, time_at);
  RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1', 'allowed', true, 'replayed', false, 'id', p_id,
    'period', to_char(month_start, 'YYYY-MM'), 'requestBytes', p_request_bytes, 'responseBytes', p_response_bytes,
    'controlOverheadBytes', 8192, 'summary', matter_reporting_app.egress_summary(time_at));
END $fn$;

CREATE FUNCTION public.matter_hosted_app_read_egress_settle(p_id uuid, p_request_bytes bigint, p_response_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE prior matter_reporting_app.egress_retry%ROWTYPE; time_at timestamptz; refund bigint; changed_rows integer;
BEGIN
  IF p_id IS NULL OR p_request_bytes IS NULL OR p_response_bytes IS NULL OR p_request_bytes < 0 OR p_response_bytes < 0
    OR p_request_bytes > 83886080 OR p_response_bytes > 83886080 THEN RAISE EXCEPTION 'Invalid bounded read-egress settlement' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('matter_reporting_app/read-egress', 0)); time_at := clock_timestamp();
  PERFORM matter_reporting_app.egress_summary(time_at);
  SELECT * INTO prior FROM matter_reporting_app.egress_retry WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1', 'settled', false, 'replayed', false,
    'reason', 'unknown-reservation', 'summary', matter_reporting_app.egress_summary(time_at)); END IF;
  IF prior.settled_at IS NOT NULL THEN
    IF prior.actual_request_bytes IS DISTINCT FROM p_request_bytes OR prior.actual_response_bytes IS DISTINCT FROM p_response_bytes THEN RAISE EXCEPTION 'Read-egress settlement identity conflicts' USING ERRCODE = '23505'; END IF;
    RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1', 'settled', true, 'replayed', true,
      'period', to_char(prior.month_period, 'YYYY-MM'), 'chargedRequestBytes', prior.actual_request_bytes, 'chargedResponseBytes', prior.actual_response_bytes,
      'controlOverheadBytes', 8192, 'summary', matter_reporting_app.egress_summary(time_at));
  END IF;
  IF prior.started_at <= time_at - interval '15 minutes' THEN RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1',
    'settled', false, 'replayed', false, 'reason', 'uncertain-bound-retained', 'summary', matter_reporting_app.egress_summary(time_at)); END IF;
  IF p_request_bytes > prior.request_bytes OR p_response_bytes > prior.response_bytes THEN RAISE EXCEPTION 'Actual read bytes exceed admission' USING ERRCODE = '22023'; END IF;
  refund := prior.request_bytes + prior.response_bytes - p_request_bytes - p_response_bytes;
  UPDATE matter_reporting_app.egress_counter SET used_bytes = used_bytes - refund
    WHERE (kind = 'month' AND period = prior.month_period) OR (kind = 'day' AND period = prior.day_period);
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 2 THEN RAISE EXCEPTION 'Read-egress original allocation is missing'; END IF;
  UPDATE matter_reporting_app.egress_retry SET settled_at = time_at, actual_request_bytes = p_request_bytes, actual_response_bytes = p_response_bytes WHERE id = p_id;
  RETURN jsonb_build_object('version', 1, 'basis', 'supabase-http-bytes-v1', 'settled', true, 'replayed', false,
    'period', to_char(prior.month_period, 'YYYY-MM'), 'chargedRequestBytes', p_request_bytes, 'chargedResponseBytes', p_response_bytes,
    'controlOverheadBytes', 8192, 'summary', matter_reporting_app.egress_summary(time_at));
END $fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA matter_reporting_app FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.matter_hosted_app_progress_read(text),
  public.matter_hosted_app_progress_cas(text,uuid,bigint,bigint,text,text,text,text),
  public.matter_hosted_app_photo_alias_read(text), public.matter_hosted_app_photo_alias_register(text,jsonb),
  public.matter_hosted_app_read_egress_read(), public.matter_hosted_app_read_egress_reserve(uuid,bigint,bigint),
  public.matter_hosted_app_read_egress_settle(uuid,bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.matter_hosted_app_progress_read(text),
  public.matter_hosted_app_progress_cas(text,uuid,bigint,bigint,text,text,text,text),
  public.matter_hosted_app_photo_alias_read(text), public.matter_hosted_app_photo_alias_register(text,jsonb),
  public.matter_hosted_app_read_egress_read(), public.matter_hosted_app_read_egress_reserve(uuid,bigint,bigint),
  public.matter_hosted_app_read_egress_settle(uuid,bigint,bigint) TO service_role;
COMMIT;
