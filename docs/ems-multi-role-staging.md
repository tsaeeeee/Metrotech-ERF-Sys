# Assigned multi-role staging

This candidate is for a **dedicated staging VM**. Do not merge it into either current production or development yet. Production stays on its current source/image/database. Staging receives a one-time snapshot, never a live database connection.

## Agreed workflow

- Independent role checkboxes per user: ERF Requestor/Reviewer/Approver, ECF Requestor/Checker/Reviewer/Approver.
- At most one active Approver account across both modules: the owner. Grants are serialized and a second active approver is rejected, including one added only to ECF.
- Check and Review are restricted to the assigned user and cannot act on that user's own request.
- The owner can submit their own request. Other assigned users must check (ECF) and review it before the owner performs final approval. The same-revision audit evidence is checked on the backend.
- Multiple roles do not grant Admin, visibility into unrelated requests, takeover, or stage skipping.
- A request retains its assigned users. Invalid reviewer/checker assignments on a resubmitted revision are replaced with eligible users. Final approval remains with the sole active Approver.
- Audit roles follow the action, not the account's primary legacy role.
- Approval Recall includes the assigned Approver. To/CC duplicates are removed without losing other recipients.
- Migration 018 is additive. Existing users keep their legacy permissions until an Admin explicitly saves their role selection. Passwords, requests, history and documents are not reset.

## Isolation

The staging Compose project has its own database, credentials, storage, sessions and Docker network. The app, DB and Mailpit are on an internal network. Only a preview reverse proxy joins an ingress network. Web access is bound to localhost ports 18090 (app) and 18091 (captured email), intended for an SSH tunnel.

`EMS_STAGING=true` forces local email capture, disables Google login and the Apps Script gateway, supplies a distinct session cookie/secret, and sets the staging base URL. Admin settings cannot override these protections. Messages retain their actual To/CC for inspection and carry `[STAGING]` in the subject. No email is relayed to company inboxes. The app displays a staging banner.

Mailpit image/ports follow its official Docker documentation: https://mailpit.axllent.org/docs/install/docker/ . No SMTP port is published. Captured messages and the copied database contain private information; do not expose them publicly or upload snapshot bundles to GitHub/chat.

Local PDF generation is used. This verifies workflow recipients and rendering, not Google/SMTP external delivery. If a real delivery test is needed later, approve a specific internal test recipient separately.

## Deployment sequence (after candidate CI passes)

1. On production, fetch the pinned candidate objects and extract `scripts/staging` into a temporary directory. **Do not checkout or pull it into the live working tree.** Run the extracted `export-production.sh`. It reads the live DB using `pg_dump`, copies PDFs/signatures, and records source revision/image and file checksums. The live app stays running. A change in documents during the snapshot aborts the export for a retry.
2. Privately transfer the resulting `.tar.gz` bundle and verify its SHA-256 on the dedicated staging VM. It includes the decryption key needed for copied encrypted application settings, so treat it as a secret backup.
3. On staging, check out the exact tested candidate commit in a separate repository. With Docker Compose available, run:

   ```bash
   bash scripts/staging/import-clone.sh /absolute/path/to/snapshot.tar.gz VERIFIED_SHA256
   ```

   The importer refuses a host with the current prod/dev app container. It creates fresh staging resources, verifies document hashes, restores the dump, snapshots row digests, applies **only migration 018**, compares the existing rows/sequences, verifies referenced documents, then starts the app and preview.
4. From the tester's laptop, tunnel to the staging VM:

   ```bash
   ssh -N -L 18090:127.0.0.1:18090 -L 18091:127.0.0.1:18091 USER@STAGING_VM
   ```

   App: `http://127.0.0.1:18090`; captured email: `http://127.0.0.1:18091`.
5. Sign in with an existing account. Configure the owner's multi-role checkboxes **in staging only**. Existing accounts/passwords are copied; no shared test-password reset runs automatically.

Do not use `scripts/release/rehearse.sh` or `upgrade-ems.js` for this import: they target the old pre-ECF production baseline.

## Acceptance checks

- Old account login, old request/history visibility, existing PDF and signature display.
- Admin grants multiple roles atomically; second Approver is rejected; existing assignments remain unchanged.
- Owner ERF/ECF submission, independent Check/Review, then owner final approval.
- Owner cannot Check/Review their own request or act on another user's assigned task.
- My Requests, My Tasks, History and Dashboard reflect all granted roles without duplicates.
- Recall on ERF/ECF retains the previous approved PDF and sends one captured notification including the Approver.
- Mobile action buttons, long descriptions and the login-refresh behavior.
- Staging banner, isolated cookie, and mail capture remain effective after Admin settings edits.

Test transactions stay in staging. After acceptance, production deployment needs its own fresh backup and reviewed migration plan; never copy the test DB back into production. To retry testing, create another fresh clone. Production is already separate and needs no rollback when a staging test fails.

The production DB dump is transactionally consistent at its snapshot time. Writes made to production afterward are not synchronized to staging. Online export adds read/IO load but does not stop or migrate the live service.
