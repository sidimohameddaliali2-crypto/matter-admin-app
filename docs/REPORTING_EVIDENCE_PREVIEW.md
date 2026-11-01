# Reporting evidence preview

The `/reports/evidence` route and sidebar entry are enabled only when `REACT_APP_REPORTING_EVIDENCE=true` at build time. They use the existing staff route guard, reports permission, and current Matter staff token. The fixed Frankfurt reporting gateway independently calls Matter GET `/api/auth/me` for every read. No new production login, database connection, API write, or background production job is introduced.

The route displays completed delivery API observations and captured photos. Original reporting assessments, decisions and source history are retained separately; observing a current record does not replace an earlier assessment. The local preview additionally links to the existing preserved reporting renderer and eight saved responses. The production route has not been deployed or activated.

The same `ReportingEvidenceView` component is bundled into the task-owned private preview at `http://127.0.0.1:63133/app`. The preview obtains reads from the prepared Matter staff tab, without copying its staff credential to localhost. Keep that tab open and use its Open reporting preview button. Reloading/closing the staff tab disconnects the preview. This is not a browser-independent hosted frontend.

A local collector reads the scheduled Dubai day every five minutes while its process and this computer run. It does not capture every intervening edit, and earlier database collections outside the delivery API remain historical imports. The page checks completed captures every minute, shows the observed time, and flags observations older than ten minutes. A failed read retains the last good capture with an error; denied staff access clears it.

Photo access uses captured, hash-verified bytes. Images retain their own retrieval time. Under the per-run photo budget, the queue rotates and keeps prior verified bindings only while the source URL and proof timestamp match. Image availability is not visual quality, a GPS visit, or physical handover.

Validated: real staff reads, current-day and 31 October capture, actual photo decoding, reload, temporary read failure/recovery, disconnect/reconnect, protected route build and connection unit tests. Full production route activation and an independently hosted 24/7 collector remain deployment work. No push/merge to main: that deploys production automatically.
