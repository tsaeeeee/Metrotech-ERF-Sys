# EMS multi-role: production rollout preparation

Prepared for the current production source `0673cfa86ead5d4451798858c7ff8d949d3645dc` at `/srv/metrotech/erf`. Do not run the old `scripts/release/cutover.sh`: it targets the earlier pre-ECF upgrade. These new scripts reject a different baseline, a changed live image after rehearsal, dirty tracked code, unexpected mounts/networks, or a mismatched candidate.

## What changes

- Only migration 018 adds the nullable `employees.workflow_roles` column, its constraint and role-checking function. Existing rows, passwords, bank profiles, workflow assignments, histories, settings and sequences are compared before/after migration and startup. Sessions are excluded from row comparison because they are transient.
- Existing users keep legacy permissions until Admin saves their per-form role checkboxes. The owner remains the only active Approver across ERF/ECF. Check and Review remain assigned and independent for the owner's own requests.
- Approval Recall copies the assigned Approver. Real mail settings, gateway configuration, master key, session settings and document mounts are preserved during production cutover.
- Startup no longer overwrites an existing admin's profile, password or activation state. Bootstrap creates an admin only when no admin account/Administrator username already exists.
- Pending requests are preflighted against the new authorization rules. Ambiguous or invalid assignments block release; they are never silently rewritten.

## Tonight: phase 1, online rehearsal

Fetch the tested candidate into the production repository's object store and extract it into a private temporary directory. Do not switch branches or pull it into the live working tree. Run:

```bash
bash EXTRACTED_DIRECTORY/scripts/release-multirole/rehearse.sh FULL_TESTED_CANDIDATE_SHA
```

The pinned commit will be supplied with the handoff. The script builds tracked candidate source, takes an online DB/document snapshot and restores it into a separate PostgreSQL container on the **same VM**. The clone has its own volume/network, no published ports and no external mail delivery. Migration 018, startup preservation, document checks and app health run against that clone. Clone containers stop after the check; the backup, candidate image and private clone volume are retained for diagnosis.

Production stays running and receives no migration during rehearsal. Snapshot reads and the image build consume shared disk/CPU. The script requires at least 2 GiB available RAM and 5 GiB free space in the home filesystem; also check space in Docker's filesystem. Clone containers have CPU/RAM limits, but the Docker image build is not constrained by those container limits. Schedule this during quiet use. If the capacity gate fails, review resources rather than bypassing it.

Expected completion: `REHEARSAL_OK`, with the candidate SHA and a directory such as `/home/deploy/ems-multirole-rehearsal.ABC123`. This is the exact directory required by phase 2. Keep it private: it contains production data and the configuration decryption key. Do not paste archive contents, environment files or inspection JSON into chat.

If rehearsal fails, stop and diagnose. No live cutover follows automatically.

## Phase 2, maintenance and cutover

After rehearsal passes, announce a maintenance window and run the script **from that rehearsal's archived source**, supplying the same tested SHA and exact successful directory:

```bash
bash REHEARSAL_DIRECTORY/code/scripts/release-multirole/cutover.sh FULL_TESTED_CANDIDATE_SHA REHEARSAL_DIRECTORY
```

Run it under `nohup` with a private log and watch with `tail --pid`, so a dropped SSH connection does not interrupt deployment. Do not substitute an old release or an unverified newest branch head.

The script:

1. Confirms source/image/runtime/mounts match the known production and tested candidate. Saves the old image and runtime configuration.
2. Closes app access and stops **only** the EMS app. The DB and other applications remain running.
3. Takes a fresh frozen database backup and copies documents; verifies document checksums.
4. Restores that fresh backup into an isolated DB, applies 018 there and exercises production startup helpers. All existing business rows and sequence values must match.
5. Applies migration 018 to live DB, recreates only the app with the tested image and preserved runtime/mounts, checks health/data/documents while access remains closed.
6. Fast-forwards the local production checkout to the candidate, updates its local image tag and reopens app access. Reports `LIVE_RELEASED`, backup directory and the guarded rollback command.

The maintenance duration depends on snapshot size and disk performance; no exact duration is promised. This preparation leaves GitHub production/dev branches unchanged. A candidate branch rollout and subsequent production-branch merge must be coordinated so source tracking stays consistent; do not deploy a different SHA or squash-merge independently.

## Rollback

Before app access reopens, deployment failures automatically attempt to restore the frozen backup and old image. If that restoration fails, access stays closed and the script reports the private diagnosis directory.

After `LIVE_RELEASED`, use only the exact **guarded rollback** command printed by the script. It first stops access and compares all business tables, sequences and document hashes to the post-release snapshot. If users have created/changed data or roles, rollback is blocked and the current app resumes. This prevents silently erasing post-release work. A rollback at that point requires a separately reviewed recovery plan.

Do not restore the online rehearsal snapshot into production. Do not switch just the image after users have adopted multi-role settings: the old app does not understand those permissions.

## Validation after release

- Existing user login and old request/history/PDF access.
- Existing pending tasks can continue with their assigned users.
- Admin edits the owner's role checkboxes deliberately; no automatic multi-role grants occur.
- Owner's own ECF requires another checker and reviewer before final approval.
- Recall notification reaches the Approver once, alongside existing recipients.
- One approved Test SMTP to your own internal inbox verifies real delivery; automated clone tests do not establish external email delivery.

No production access, data copying, service restart, merge or live migration has been performed while preparing these scripts. Full CI uses disposable synthetic data.
