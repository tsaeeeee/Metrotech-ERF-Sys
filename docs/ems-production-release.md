# ERF to EMS production release candidate

Status: **rehearsal only; not approved for live rollout**.

Verified source baselines:

- Existing production: `332903bd57e645ca3683b4ed46a8658e45bf5641`.
- Tested EMS source: `dfa55451bf0fa45c7514c4178fda670fb082b0b4`.
- Candidate commit is supplied explicitly to the rehearsal script and recorded
  alongside the snapshot. Do not substitute a moving branch during deployment.

The candidate reconciles production with the EMS tree. Production history,
wrapping, decision recalls, and UI fixes were ported to EMS in PR #11; subsequent
EMS fixes remain included. No production-only file is removed. Production compose
volume and network names remain unchanged. Production stays on its existing
branch until the rehearsal and acceptance checks pass.

## Migration contract

`scripts/release/upgrade-ems.js` applies 008–012 and 015–017 inside a single
transaction. It rejects an already/partially migrated database and uses a short
lock timeout. It does not run schema.sql, dev seeds, TRUNCATE, 013, or 014.
Existing password/signature onboarding flags therefore remain untouched.

Before commit it checks full row digests and counts of employees, requests,
request items, workflow actions, email log, daily counters, and app settings;
sequence values must also match. The only allowed difference in existing rows
is the new `requests.form_type='ERF'` field. Failure rolls back all migration
DDL and data changes. The dry-run path also rolls back successful migrations.

New ECF access defaults follow the reviewed migrations: active ERF Requestors
receive ECF Requestor access; Reviewer/Approver access is inherited. An admin
must explicitly assign the Checker before ECF submission is ready. No test
users or bank profiles are installed in production by the migration.

## Rehearsal on the production VM

Run `bash scripts/release/rehearse.sh FULL_CANDIDATE_SHA` using a script extracted
from that same verified commit, with the existing checkout at `/srv/metrotech/erf`.
The script does not checkout/pull the live branch, stop the live app, or write
to the live database. It does tag the old image for retention, create an online
database dump, copy documents, and create isolated Docker resources.

Outputs are private under `$HOME/metrotech-ems-rehearsal/TIMESTAMP` (0700).
They contain production data and secrets: do not upload them or paste their
contents in chat. Only share the preservation report counts and error summary.

- Candidate builds from `git archive`, excluding untracked .env/backups.
- Database is restored into a new container and new volume, using fresh clone
  DB credentials. This is also a practical restore test of the dump.
- Document copies are SHA-256 compared against source files. Concurrent file
  changes cause the comparison to fail rather than claiming consistency.
- Clone settings disable SMTP and Google login, enable local login and HTTP
  cookies, and use a local base URL. Gateway variables are cleared.
- A Docker `--internal` network blocks external access. The app is reachable
  only at `127.0.0.1:18089`, normally through an SSH tunnel.
- Rendering is `PDF_MODE=mock` in rehearsal. If production uses Google Sheets,
  its renderer and external integration still require a separate controlled
  acceptance check. Rehearsal does not validate outbound mail delivery.
- Failure stops rehearsal containers and retains artifacts for diagnosis.
  Live service stays running. No cleanup command targets production resources.

This is an online rehearsal snapshot, **not** a final point-in-time rollback
backup: the live service can accept new writes after/during the dump and copy.

## Acceptance gate before live rollout

1. CI production-upgrade test passes using the exact production schema fixture;
   full ERF/ECF, UI, PDF, and recall checks pass on the candidate.
2. Real-data rehearsal reports unchanged legacy table contents and sequences.
3. Existing users can log in with existing passwords; role access is correct.
4. Existing Approved and Recalled records show unchanged amounts, items,
   history, and available PDF/evidence. Old approved PDFs remain unchanged.
5. In the clone, configure a Checker and test a new ERF and ECF through all
   stages, rejection/revision, approval Recall, and PDF bank details.
6. Record acceptance and verify production has not moved from its baseline.
   Review actual production config without printing secrets.

Do not run the synthetic CI fixture scripts against production. They are not
production migration tools. Do not deploy merely because `/health` is green.

## Live rollout and rollback gate (not automated by rehearsal)

After acceptance: schedule a write freeze/maintenance window, retain the old
image, take fresh matching DB/documents/signature/config backups, restore-test
them, build/pin the accepted image, then stop app writes and run the reviewed
migration on the existing database. Reuse its existing credentials, volumes,
master key, session settings and proxy networks. Start only the app container;
validate old records and accounts before opening user access.

If migration fails, its outer transaction rolls back and the old app can remain
on the baseline. If failure occurs after commit, keep writes stopped and restore
the matching pre-upgrade database/documents plus old app image/config. Do not
blindly roll back only code once new ECF transactions exist. Post-cutover writes
require reconciliation before any snapshot restore to avoid losing new data.

Production merge/deployment commands will be pinned to the accepted candidate
after the real-data rehearsal results are reviewed.
