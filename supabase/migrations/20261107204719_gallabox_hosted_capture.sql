-- Isolated Gallabox execution state. No driver/reporting tables are changed.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE TABLE gallabox_private.worker_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
 writer_mode text NOT NULL DEFAULT 'local' CHECK(writer_mode IN ('local','cloud')),
 token_hash text NOT NULL, lease_token text, lease_until timestamptz,
 last_started_at timestamptz, last_success_at timestamptz, last_error text,
 runs bigint NOT NULL DEFAULT 0, provider_reads bigint NOT NULL DEFAULT 0,
 inserted_messages bigint NOT NULL DEFAULT 0
);
CREATE TABLE gallabox_private.worker_scope (
 scope text PRIMARY KEY, channel_id text NOT NULL, last_discovery_at timestamptz,
 next_discovery_at timestamptz NOT NULL DEFAULT now(), error text, recent_count int, open_count int
);
CREATE TABLE gallabox_private.worker_job (
 scope text NOT NULL REFERENCES gallabox_private.worker_scope(scope), contact_id text NOT NULL,
 lane text NOT NULL CHECK(lane IN ('live','history')), conversation jsonb NOT NULL,
 page integer NOT NULL DEFAULT 1, page_size integer NOT NULL DEFAULT 100,
 page_hashes jsonb NOT NULL DEFAULT '[]', pending boolean NOT NULL DEFAULT true,
 retry_at timestamptz NOT NULL DEFAULT now(), failures integer NOT NULL DEFAULT 0,
 provider_updated_at text, last_success_at timestamptz, error text,
 PRIMARY KEY(scope,contact_id,lane)
);
CREATE INDEX worker_job_pending ON gallabox_private.worker_job(lane,retry_at) WHERE pending;
CREATE TABLE gallabox_private.worker_run (
 id text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 outcome text NOT NULL, provider_reads integer NOT NULL DEFAULT 0, inserted integer NOT NULL DEFAULT 0,
 duplicates integer NOT NULL DEFAULT 0, pages integer NOT NULL DEFAULT 0, duration_ms integer,
 error text
);
CREATE TABLE gallabox_private.provider_message (
 scope text NOT NULL, external_id text NOT NULL, sha256 text NOT NULL,
 payload jsonb NOT NULL, first_captured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope,external_id,sha256)
);
CREATE INDEX provider_message_identity ON gallabox_private.provider_message(scope,external_id);
CREATE TABLE gallabox_private.capture_conflict (
 scope text NOT NULL, external_id text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL, saved_sha256 text, received_sha256 text,
 PRIMARY KEY(scope,external_id,received_sha256)
);
CREATE INDEX IF NOT EXISTS inbox_native_conversation ON gallabox_private.inbox_record
 ((body->>'scope'),(body->>'externalConversationId')) WHERE kind='serviceconversations';
CREATE INDEX IF NOT EXISTS inbox_native_contact ON gallabox_private.inbox_record
 ((body->>'scope'),(body#>>'{sourceMetadata,externalContactId}')) WHERE kind='serviceconversations';
CREATE INDEX IF NOT EXISTS inbox_native_message ON gallabox_private.inbox_record
 ((body->>'scope'),(body->>'externalMessageId')) WHERE kind='servicemessages';
ALTER TABLE gallabox_private.worker_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.worker_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.worker_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.worker_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.provider_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.capture_conflict ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA gallabox_private FROM PUBLIC,anon,authenticated;
