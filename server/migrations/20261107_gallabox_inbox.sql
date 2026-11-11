-- Private Gallabox persistence only. No driver/reporting objects are modified.
CREATE SCHEMA IF NOT EXISTS gallabox_private;
REVOKE ALL ON SCHEMA gallabox_private FROM PUBLIC, anon, authenticated;
CREATE TABLE gallabox_private.inbox_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0,
 origin text NOT NULL,
 captured_at timestamptz,
 committed_at timestamptz
);
CREATE TABLE gallabox_private.inbox_record (
 kind text NOT NULL, id text NOT NULL,
 body jsonb NOT NULL, payload text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL,
 PRIMARY KEY(kind,id), CHECK(body->>'_id'=id)
);
CREATE TABLE gallabox_private.inbox_record_history (
 kind text NOT NULL,id text NOT NULL,revision bigint NOT NULL,
 payload text NOT NULL,sha256 text NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,id,revision)
);
CREATE TABLE gallabox_private.inbox_staging (
 run_id text NOT NULL,kind text NOT NULL,id text NOT NULL,
 body jsonb NOT NULL,payload text NOT NULL,sha256 text NOT NULL,
 PRIMARY KEY(run_id,kind,id),CHECK(body->>'_id'=id)
);
CREATE TABLE gallabox_private.inbox_commit (
 run_id text PRIMARY KEY,revision bigint UNIQUE NOT NULL,records integer NOT NULL,captured_at timestamptz NOT NULL,committed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gallabox_private.inbox_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.inbox_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.inbox_record_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.inbox_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE gallabox_private.inbox_commit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA gallabox_private FROM PUBLIC,anon,authenticated;
CREATE INDEX inbox_record_thread ON gallabox_private.inbox_record(kind,(body->>'conversationId'));
CREATE INDEX inbox_record_contact ON gallabox_private.inbox_record(kind,(body->>'source'),(body->>'scope'),(body#>>'{sourceMetadata,externalContactId}'));
CREATE INDEX inbox_record_issue ON gallabox_private.inbox_record(kind,(body->>'issueId'));
CREATE INDEX inbox_record_message_time ON gallabox_private.inbox_record((body->>'conversationId'),(body->>'sentAt') DESC,id DESC) WHERE kind='servicemessages';
CREATE UNIQUE INDEX inbox_record_message_source ON gallabox_private.inbox_record((body->>'source'),(body->>'scope'),(body->>'externalMessageId')) WHERE kind='servicemessages';
