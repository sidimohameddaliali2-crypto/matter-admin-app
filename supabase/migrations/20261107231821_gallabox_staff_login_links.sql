CREATE TABLE gallabox_private.staff_login (
 provider text NOT NULL CHECK(provider IN ('supabase','matter')),
 subject text NOT NULL,
 staff_id text NOT NULL REFERENCES gallabox_private.staff_directory(id),
 active boolean NOT NULL DEFAULT true,
 linked_at timestamptz NOT NULL DEFAULT now(),
 evidence text NOT NULL,
 PRIMARY KEY(provider,subject), UNIQUE(provider,staff_id)
);
CREATE INDEX staff_login_staff ON gallabox_private.staff_login(staff_id);
ALTER TABLE gallabox_private.staff_login ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON gallabox_private.staff_login FROM PUBLIC,anon,authenticated;
CREATE INDEX inbox_message_date ON gallabox_private.inbox_record((body->>'sentAt'),(body->>'conversationId')) WHERE kind='servicemessages';
