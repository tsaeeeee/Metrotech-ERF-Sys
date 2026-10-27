# Dashboard summaries and request drafts

The dashboard displays one ERF group and one ECF group, subject to the user's module access. Each group contains In Progress and Approved amounts and counts. In Progress includes PENDING_CHECK, PENDING_REVIEW and PENDING_APPROVAL. Clicking a metric opens a filtered, paginated History & Progress list with the same visibility rules as the metric. This does not grant early approval rights. Administrators can read dashboard summaries without gaining workflow actions or document access.

Requestors have a Draft entry in Activity and Save Draft on new ERF/ECF forms. Saving accepts incomplete fields, the currently edited payment, and PDF/JPG/PNG evidence. Drafts are private to the current account. Continue restores the form and original evidence, including after logout or app recreation. Delete uses an in-app confirmation. New ERF / New ECF starts a separate draft. Saving is explicit, not automatic; unsaved edits are not guaranteed to survive a refresh.

A draft is not a request: saving it does not allocate a reference number, enter an approval queue, send mail, or create workflow history. Current access, bank-profile requirements, evidence requirements and workflow routing apply when submitting. Save Draft is for new requests; recalled/rejected request revisions continue using their existing revision workflow.

## Persistence and recovery

No schema migration is needed. Drafts are stored under `PDF_DIR/drafts` on the existing writable PDF volume, outside request/document directories. An owner hash and random UUID separate each private draft. Files use private permissions. Evidence is written and synced before an atomic JSON manifest replacement publishes a new version. Advisory locks and version checks prevent concurrent overwrites; a stale tab must reopen the draft before saving again.

Submission uses the draft UUID as the new request ID. It creates the request through the existing ERF/ECF workflow transactions. Retrying a committed submission completes the same request instead of allocating a second reference. Submitted drafts leave the list and their draft evidence copies are removed after request documents are generated. A small receipt remains for retry safety. Request evidence remains in the normal request directory.

If document generation fails after the request transaction commits, the saved draft remains recoverable. Reopen it and Submit again to finish. The committed form cannot be edited or deleted as a draft; subsequent changes use the normal request recall/revision flow. As with existing workflow mail, email delivery failures are recorded in email_log and are not treated as permission to recreate a request.

Limits: 100 unsubmitted drafts per owner, 16 payment lines per draft, 64 evidence files, and the configured MAX_EVIDENCE_MB total (default 15 MB). The unfinished editor counts toward that evidence limit. Saved drafts are excluded from dashboard transaction totals.

## Operations

Backups of the existing PDF volume must include the `drafts` subdirectory. Preserve the volume when recreating the application. Do not clear it or use `docker compose down -v`. No new Docker volume, database reset, or migration command is required.

Deploy as an app-only release using the established runtime/mount-preservation checks, retaining the current image for rollback. Verify the running source and image first: the last confirmed production source for this change is 5a1db2f55884fa29ac1e04be2d070c380b281498. The remote production-erf branch may not match the live checkout; do not use an unqualified pull to replace the running code. Production deployment is separate from this pull request.

Rolling the app back to the preceding release leaves existing requests usable and the draft directory intact. The preceding UI has no Draft menu; unsubmitted drafts become accessible again when the feature is restored. Database restoration is not part of rolling back this release.

## Verification

`scripts/drafts-http-smoke.js` runs against the disposable CI database after the workflow/HTTP fixtures. It checks incomplete drafts without transaction/counter/mail changes, account isolation, attachment bytes, persistence across a server restart, stale-version rejection, concurrent submission, recovery after database commit, existing stage-order and bypass permissions, and dashboard count/list parity for each role.

`scripts/ems-ui-smoke.js` checks the shipped controls, reload-and-resume with evidence, ERF/ECF separation, submission, the delete dialog, existing role navigation and mobile layouts. Test fixtures must never run against production.
