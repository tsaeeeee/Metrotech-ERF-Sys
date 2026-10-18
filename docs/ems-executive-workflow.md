# Executive workflow and shared review

This change builds on the deployed `dd100a9` progress-visibility release. It is
prepared in a separate branch; it does not configure real accounts or deploy
itself to production.

## Rules

- ERF normally follows Requestor → Review → Approval. ECF adds Check before Review.
- Primary reviewers share a queue. The first committed approve/reject wins.
  The recorded reviewer and PDF signature belong to that actor. Self-review and
  self-check remain prohibited.
- A Secondary executive can manually **Take Over** an eligible pending stage,
  with a reason, then make a separate decision. There is no timer, queue-size
  threshold, automatic escalation, or automatic takeover.
- If no ordinary checker/reviewer is eligible but a secondary is available, the
  request stays in that pending stage awaiting manual takeover. The executive
  can see it in History & Progress; it is not automatically put in My Tasks.
- Own-request bypass requires the explicit per-form permission and Approver +
  Requestor access. Each submit/resubmit asks again. Normal Workflow is the
  default. Bypass requires a reason and moves to the same person's Pending
  Approval; it does not final-approve. Skipped signatures are not drawn.
- Only one active Approver remains permitted globally across ERF and ECF.
- Approval notes are optional; rejection notes remain required. Notes appear in
  request details, audit, and both HTML/plain-text workflow email. The summary
  only includes the current revision; older notes remain in audit.
- All assigned participants can follow progress from submission. Visibility
  does not grant an early decision. Requestor details show, for example,
  `Pending review by Dimas/Rizal`.

## Suggested configuration (admin applies this separately)

| Person | Workflow options |
| --- | --- |
| Dimas and Rizal | Reviewer for applicable forms; Primary shared queue; optional short workflow display name |
| Ervan | Sole Approver; Requestor/Reviewer as required; Secondary manual review; optional own-request bypass; ECF Checker + Secondary check if needed |
| Kilat | Requestor and ECF Checker; Primary check |

These names are examples, not identity checks in application code. Options are
saved with User Management changes in one transaction. Changing routing affects
submissions/resubmissions; existing requests retain their captured participants.
Existing requests with no workflow plan keep their original single assignee.

## Database and rollout

Migration `019-executive-workflow.sql` adds nullable `employees.workflow_options`
and `requests.workflow_plan`. It permits empty reviewer/checker assignments for
an explicit bypass or a stage waiting for manual takeover. It does not update
existing accounts, passwords, requests, notes, reference counters or documents.

`scripts/release-executive/upgrade.js --dry-run` applies the migration inside a
transaction, compares digests/counts of every existing public table (excluding
sessions and the new fields), checks sequences, then rolls back. `--apply`
performs the same checks and commits. It requires the multi-role baseline.

Before live rollout: rehearse against a private production clone with outbound
mail captured locally; take and restore-check a fresh database/documents backup
while writes are paused; preserve the current runtime settings and mounts; apply
the migration and start the pinned candidate; verify existing login, requests,
PDFs and mail.

The `scripts/release-executive` release tools pin the deployed `dd100a9` baseline.
`rehearse.sh FULL_SHA` builds tracked source outside the live checkout, restores
an online snapshot to an isolated clone, tests dry-run/apply and startup while
checking original rows and documents, then records `REHEARSAL_OK`. It does not
stop or migrate production and exposes no clone ports or outbound email.

`cutover.sh FULL_SHA REHEARSAL_DIRECTORY` accepts only that successful rehearsal,
unchanged source baseline and original running image. It preserves runtime env
and mounts, pauses app access, takes/restores/checks a fresh backup, migrates,
recreates only the app using the rehearsed image, checks health/data/documents,
then restores proxy access. A pre-open failure restores the matching old image,
database and documents. The saved `rollback.sh` refuses to rewind new writes
after access opens. Do not run the historical ERF/EMS or multi-role cutover tools
for this release.

Do not treat switching only the image as a safe rollback after new workflow
requests exist: the previous application does not understand reviewer pools,
bypass or nullable assignments. A rollback needs a validated compatibility plan
or the pre-cutover database/documents snapshot while writes are still paused.
Restoring an older snapshot after users resume work would lose their new writes.

Previously discarded approval notes cannot be reconstructed. This fix preserves
notes on subsequent decisions.

## Verification

`scripts/executive-workflow-smoke.js` runs only in CI in a dedicated disposable
PostgreSQL database. It checks migration dry-run/idempotence and preservation,
single Approver, primary queue concurrency, no self-check/review, permissioned
bypass, manual takeover, revision conflicts, all decision notes, escaped email,
local PDF bypass markers, HTTP locking and a local mail capture server.

The existing workflow, multi-role, HTTP, PDF and browser regression suites remain
enabled. Browser tests additionally cover the custom submission choice, cancel,
normal flow, bypass payload, compact reviewer text, note escaping, and manual
takeover before decision controls become available.
