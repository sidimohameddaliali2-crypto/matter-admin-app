# Customer Service review pack maintenance

Saved user instruction, 10 November 2026: keep the shared presentation, workflow maps, data/report definitions, policies and acceptance material current when the app's components or behaviour change. Apply this instruction while completing authorized work. This is a change-triggered maintenance rule, not a scheduled background sync.

## Canonical locations

Use the existing [Matter Logistics / Customer Service folder](https://drive.google.com/drive/folders/1A8s5X94eCDyIG2GrekfL0GzDpx5ISc_Z). Maintain these files in place so links and review history survive:

| Material | Stable file ID | Contents to keep current |
| --- | --- | --- |
| Matter Customer Service.pptx | `1jpV5bX2h5hmrV_z3nr9coARGdUi3La9O` | Staff journey, screenshots, correct Matter logo and concise explanations. |
| Workflows Data and Reports | `1woQMTJ2zCgd861OnUIPZbsNbrYoLhF_Bm-Ox-gK8fug` | Flows, Topics, Actions, Data capture, Reports, Legacy mapping. |
| Policies Decisions and Sources | `1R1zAVKLFNOAnLhkGQbVHJV6EZSAmIHr5TgBfssiyDYo` | Rules, Decisions, Sources, Coverage. |
| Staff and Release Acceptance | `17tqsqfyyTr3pQ3P-xEjoKbRINRGh5SsOevwjgTE1SwM` | Staff tasks and Release gates, including actual participants, verdicts and evidence. |
| Sidi Admin and Supabase.md | `1np-OpNYO1mvMQfMibOCPRNe4etB5aJBZ` | Current destination, runtime, preservation, migration, rollback and remaining work. |
| 00 START HERE.md | `1UoBO7aixpJYHtpJ43p9NEf2940Yf90V1` | Folder index, dated scope, current next actions and links. |

This guide is also copied to the shared root as `01 MAINTENANCE.md`. Keep the repo guide and shared copy aligned. The local artifact mirror is `Matter/Customer Service`; its `.build` folder contains private snapshot builders and validation receipts, not staff deliverables.

## What triggers an update

| Change | Update the affected material | Verification needed |
| --- | --- | --- |
| Components, navigation, wording, controls, layout or branding | Presentation screenshots/instructions, Flows and affected Staff tasks. | Follow the actual rendered journey; check desktop and a measured narrow layout, keyboard, scrolling and validation where affected. Use the approved logo asset. |
| Topic/detail vocabulary, action, outcome or conditional field | Topics, Actions, Flows, Legacy mapping, Data capture and relevant acceptance cases. | Enumerate the current registries; compare every choice and required field with UI and API validation. Preserve existing stored IDs/history. |
| Storage, provider events, attachments, history or report logic | Data capture, Reports, migration note and relevant Release gates. | Check persistence/reload, source linkage and failures/recovery. Reconcile report counts with their population and drilldowns. Test actual media playback/download when affected. |
| Existing login, identities, permissions, assignment or sensitive closure | Flows, Decisions, migration note and permission tasks/gates. | Verify permitted and denied UI/API actions, revocation and exact account mapping. Keep CS reads/commands/history in canonical Supabase. |
| Business rules, staff responsibilities, deadlines or evidence requirements | Rules, Decisions, Sources, affected flow/field definitions and presentation. | Read the approved source; retain who approved it, version, effective date/scope and conflicting evidence. Distinguish a proposed answer from an adopted rule and its implementation. |
| Integration target, environment, rollout status or verification result | Migration note, readiness record, START HERE and Staff tasks/Release gates. | Pin the current candidate and data cutoff. Keep local engineering, destination, provider and real staff acceptance as separate verdicts. |

Pure refactoring with unchanged observable behaviour needs an impact check, not new screenshots or a full rewrite. Record why the current material remains valid.

## Update procedure

1. Confirm the active repository/worktree, current component paths and tested app commit. Read the current shared files before editing. Their latest staff answers and reviewer edits take precedence over an older local export.
2. Identify the affected flows and documents from the table above. Read the actual execution path and approved sources; do not copy an old count, label, policy or success claim into a new version without checking it.
3. Regenerate topic/action/field rows from `server/config/customerServiceTopicTags.js`, `customerServiceActions.js` and `customerServiceRequests.js`, or their verified successors after migration. Follow current implementations for history, reporting, permissions and persistence. Refresh counts and registry/version labels; 10 topics, 50 details and other launch counts are dated snapshots, not permanent constants.
4. Update only the affected material. Use targeted native Sheet/table edits keyed by stable IDs. Preserve accepted decisions, entered answers, assignees, reviewer comments, verdict history and evidence. Append a new verification entry when behaviour changes; retain the older entry with its tested version and mark the current affected item Not started with a clear retest reason. Do not carry an older Passed result forward as proof for changed behaviour.
5. Capture screenshots from the working authorized preview using clearly labelled synthetic cases. Keep customer exports, raw recordings, credentials and private evidence out of the shared pack and Git. Show optional and required fields as they actually work. An internal record is distinct from a message sent, approved remedy, paid refund or completed operational action.
6. Validate the changed complete journey and its relevant reload/failure/recovery paths. Review the presentation rendering, native Sheet formulas/tables/dropdowns, source links and file parents. Recheck meaningful changed outcomes; document blocked or unverified items explicitly.
7. Replace the existing PPTX file in place and edit the existing native Sheets. Keep their file IDs, links and inherited sharing unchanged. Read back the published file/ranges to verify completion. Record the reviewed date, app/registry version, changed sections, evidence, result and next action in the existing readiness/checkpoint and acceptance records. Keep detailed technical receipts locally.

The local `.build/content.mjs`, `build-workbooks.mjs` and `build-deck.mjs` are snapshot helpers. Before reusing them, verify their registry import paths, hard-coded app/date/count labels, latest source facts, screenshot paths and output settings. Use a fresh validation receipt. Do not import a regenerated whole workbook over native staff input or blindly overwrite a PowerPoint that people have edited since the last local build.

## Decisions and boundaries to preserve

- The approved FAQ/rulebook baseline was recorded as owner-approved on 7 November 2026. Check for approved revisions; older Pocket discussion or historical training does not supersede it automatically. Keep the specific remaining questions and accepted answers in Decisions.
- Sidi's existing admin app is the selected destination. Keep its existing login and canonical Supabase customer-service read/command/history path. Confirm the actual destination head before integration; do not create another CS store or a second collector.
- Preserve existing data, legacy topic IDs, conversations, sibling issues, drafts and complete history. Chat closure and issue resolution remain separate. Add issues to conversations; messages can supply evidence.
- Keep reports already implemented, reports derivable from retained records and reports needing operational linkage distinct. Missing evidence is not zero. Source media references do not establish playable archives or durable playback telemetry.
- This maintenance instruction does not authorize deployment, remote migrations, customer/staff sends, provider actions, broader access or a new release decision. Work within the user's authorized scope and retain unverified gates.

## Completion checklist

- [ ] Affected flows, registry rows and documents reconciled with the tested app version; unchanged material assessed.
- [ ] New screenshots and instructions match the current UI where required.
- [ ] Staff answers, audit history, source authority and evidence preserved; affected verdicts marked for retest.
- [ ] Changed artifacts validated, saved in place and read back from the shared folder.
- [ ] START HERE, the current readiness/checkpoint and relevant acceptance evidence updated with remaining gaps.
