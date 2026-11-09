CREATE TABLE gallabox_private.local_artifact_archive (
 name text NOT NULL, sha256 text NOT NULL, raw_bytes bigint NOT NULL,
 encoding text NOT NULL CHECK(encoding='gzip-base64'),
 payload text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(name,sha256)
);
ALTER TABLE gallabox_private.local_artifact_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gallabox_private.local_artifact_archive FROM PUBLIC,anon,authenticated;
