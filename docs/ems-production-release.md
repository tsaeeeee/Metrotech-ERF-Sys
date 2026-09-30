# ERF to EMS production release candidate

Status: **owner authorized production rollout after the real-data rehearsal**.
Run the cutover only from the reviewed release commit after its CI passes.

Verified source baselines:

- Existing production: `332903bd57e645ca3683b4ed46a8658e45bf5641`.
- Tested EMS source: `dfa55451bf0fa45c7514c4178fda670fb082b0b4`.
- Accepted rehearsal application: `c3cc59c9c78ef02f25901ec585e0d19ca2859c9a`.
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
- A Docker `--internal` network isolates the clone. The localhost preview port
  was not reachable on the actual VM; internal application health passed.
  A printed preview URL therefore does not establish browser access.
- Rendering is `PDF_MODE=mock` in rehearsal. If production uses Google Sheets,
  its renderer and external integration still require a separate controlled
  acceptance check. Rehearsal does not validate outbound mail delivery.
- Failure stops rehearsal containers and retains artifacts for diagnosis.
  Live service stays running. No cleanup command targets production resources.

This is an online rehearsal snapshot, **not** a final point-in-time rollback
backup: the live service can accept new writes after/during the dump and copy.

## Evidence and remaining acceptance checks

The actual VM rehearsal on 2026-09-29 preserved all seven legacy tables and
sequences: 5 employees, 2 requests, 10 items, 13 workflow actions, 13 email log
entries, 2 counters and 21 settings. Password hashes and existing record contents
matched; PDF/signature copies matched. Only the clone was migrated.

The candidate CI covers synthetic old-user login, old PDF bytes, full ERF/ECF
workflows, UI, PDF and recalls. The Docker cutover CI additionally exercises the
production scripts against a disposable old application/database, an injected
failure after migration, full restoration, successful release, and rejection
of rollback when new data exists.

Browser UAT against the real-data clone and real outbound SMTP delivery have
**not** been verified. The owner authorized proceeding with this limitation.
After cutover, verify old-user login, old records/PDF, role access, and one Admin
Test SMTP to an authorized internal inbox. Configure the ECF Checker explicitly
before allowing ECF submissions. Health checks alone do not prove these flows.

Do not run the synthetic CI fixture scripts against production. They are not
production migration tools. Do not deploy merely because `/health` is green.

## Controlled live cutover

Extract `scripts/release` from the pinned production release into a temporary
directory, then run `bash cutover.sh FULL_PRODUCTION_RELEASE_SHA`. Do not pull
the live checkout first. The script requires the exact old production baseline,
a clean tracked tree, and the healthy accepted rehearsal container. It uses that
container's immutable image ID and rejects any release with different runtime
source, SQL, Dockerfile, dependency manifests or production Compose file.

Before maintenance it captures runtime config privately and checks the resolved
Compose environment matches. It disconnects only the application from the proxy
and stops it, then takes a fresh DB dump, globals, PDF/signature and config backup.
It restores that dump into a new isolated database and compares legacy contents
before migrating the live DB. Existing DB credentials, volume, master key, mail
settings and proxy identity are retained. The DB container is not recreated.

After migration it verifies legacy data, document bytes, runtime environment,
mounts, application image and internal health before reopening proxy access.
The Git checkout advances only to the pinned source. Maintenance lasts through
the backup, restore test and validation; the application is unavailable during
that interval. Backup files contain production data/secrets and remain private
under `$HOME/metrotech-ems-cutover/TIMESTAMP`.

External mail is not sent by the cutover or its CI. Runtime/settings preservation
protects no-reply configuration, but delivery still needs the controlled check.

## Rollback

Before public access opens, a failed migration/startup/validation triggers a
matching database/PDF restore and old image/config restart. Restoration failure
keeps access closed and prints the backup directory for diagnosis.

After public access opens, use the backup's `tooling/rollback.sh` with its backup
directory argument. It pauses writes, compares every public table except session
and all sequences/documents to the release snapshot, and refuses restoration if
they changed. In that case it resumes the current app; reconcile the new data
before any restore. Successful guarded rollback restores the old database/image,
PDF and checkout. Never restore an earlier snapshot blindly after new work exists.
