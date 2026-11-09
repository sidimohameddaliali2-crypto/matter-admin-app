CREATE SCHEMA IF NOT EXISTS customer_service_private;
REVOKE ALL ON SCHEMA customer_service_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS customer_service_private.live_source (
 source text PRIMARY KEY CHECK (source IN ('matter_api_subscriptions','nutrition_mysql_customers')),
 generation text NOT NULL CHECK (generation ~ '^[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL,
 persisted_at timestamptz NOT NULL DEFAULT now(),
 customer_count integer NOT NULL CHECK (customer_count BETWEEN 0 AND 10000),
 payload text NOT NULL CHECK (octet_length(payload) <= 8388608 AND jsonb_typeof(payload::jsonb)='object')
);
ALTER TABLE customer_service_private.live_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customer_service_private.live_source FROM PUBLIC, anon, authenticated;
-- Extend an existing API-only table without replacing its saved generation.
ALTER TABLE customer_service_private.live_source DROP CONSTRAINT IF EXISTS live_source_source_check;
ALTER TABLE customer_service_private.live_source ADD CONSTRAINT live_source_source_check
 CHECK (source IN ('matter_api_subscriptions','nutrition_mysql_customers'));
