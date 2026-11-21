# Cash Tracker and request visibility

This release is based on `feature/dashboard-drafts` at `c509d95`. It does not deploy itself. Use the pinned release commit and the successful rehearsal output when scheduling production cutover.

## Workflow changes

- My Requests shows all non-approved requests involving the signed-in employee from submission onward, including returned/recalled requests. Needs My Action filters the same list to actions currently assigned to that employee. Pagination covers more than 50 records.
- History contains final APPROVED records only. A recall moves the request back to My Requests. It does not erase the audit trail or archived approved PDF.
- An employee who approved Check cannot Review or take over Review on that same ECF revision. Their visibility is retained. Another assigned primary Reviewer acts, or the existing authorized executive uses the explicit manual takeover path. No new role, automatic escalation, or additional Approver is created.
- If no independent review path exists, the action is blocked with an explanation. Configure an independent Reviewer, then recall/resubmit an existing request to capture the updated routing. Existing assignments are not silently rewritten.
- Executive own-request bypass, single Approver, approval notes, recalls, drafts, and mail configuration remain supported.

## Cash access and accounting

Admin grants No Access, View, or Manage in User Management or Cash Settings. Every account starts with No Access, including Admin. Administrative setup is separate from viewing or entering cash transactions.

Cash Tracker has its own dashboard and annual books, category filtering, search, pagination and running balances. New entries use either income or outcome and two decimal places. Manage users can edit activity, income and outcome, or delete entries using icon actions. Edit saves before/after values with the actor and timestamp. Delete requires a reason and marks the stored entry voided, removing it from active lists and all balance/chart totals while retaining it in Log, detail audit and database backups. Annual spreadsheet sync clears its input cells without deleting the physical row. Both operations check the record version under a row lock, so simultaneous or stale changes are rejected. Dates, categories, book, original creator and import provenance are not changed by edit. Existing dual-sided legacy adjustments can retain both monetary sides; opening entries remain income-only. Save retries reuse the same entry ID. No ERF/ECF record is created by Cash Tracker.

Migration `020-cash-tracker.sql` adds only cash tables/indexes. It never deletes or updates existing employees, passwords, roles, requests, items, actions, settings, or counters. The guarded upgrader checks the complete contents of pre-existing tables and existing sequences before committing; `--dry-run` rolls back.

## Legacy import

Read the latest source immediately before the one-time import, after the feature is deployed and before enabling daily exports. Ask spreadsheet editors to pause edits during capture and reconcile any later spreadsheet edits before switching entry to EMS. EMS becomes the entry source after cutover; this is not a two-way synchronization.

The private JSON snapshot contains every sheet, raw formulas, effective values, original row numbers, cell notes and source metadata. Blank sheets remain in the archived snapshot. Unrecognized populated sheets block the whole import. The raw snapshot is stored with its checksum in `cash_imports`; the financial contents must never be committed to Git.

Each year is a separate cash book. Existing carryover rows become opening entries without counting them as new income. A missing carryover is not fabricated. Identical source rows, dual-sided legacy adjustments and blank descriptions are preserved and flagged in the preview. Category whitespace is normalized in entries while the original remains in the snapshot. Totals are calculated with integer cents and reconciled against stored rows; inconsistent spreadsheet summaries are reported, not copied into balances.

An import is one database transaction protected by a database lock. Repeating the same checksum is a no-op. A different snapshot for an already imported workbook is rejected for reconciliation, preventing a second copy of its transactions. The source spreadsheet is not modified by import.

With an authorized Google service account, create a fresh snapshot:

```bash
CASH_GOOGLE_KEY_FILE=/private/ems-cash-google.json \
  node scripts/cash-snapshot.js \
  EXISTING_SPREADSHEET_ID \
  /private/cash-latest.json
```

The capture checks Drive version/modified time before and after reading every tab. If it changes, no snapshot file is written. Alternatively use the private snapshot prepared through the connected Google account, after verifying it is still current.

In EMS: Cash Settings → Import Legacy Data → Preview Import. Review every sheet, count, balance and warning, then confirm Import All Sheets. The same operation is available as a CLI inside the deployed app:

```bash
node scripts/cash-import.js /private/cash-latest.json --preview
node scripts/cash-import.js /private/cash-latest.json --apply REVIEWED_SHA256 ACTIVE_ADMIN_EMAIL
```

Replace the final two placeholders with the exact preview checksum and an existing active Admin email. The CLI refuses an unrecognized Admin. Do not run test fixture scripts on production.

## Daily spreadsheet backup

Backups use an independently configured Google service account. Enable Google Sheets API in its project (Drive API is needed only for the separate import snapshot CLI), share the existing workbook with its service-account email as Editor, and mount its JSON credential **read-only** in the app at `/run/secrets/ems-cash-google.json`. Set `CASH_GOOGLE_KEY_FILE` to that container path. Never paste the credential into chat or commit it. Preserve the current app environment, PDF volume, signature mount, project name, image and networks when adding this configuration; do not recreate the database.

After import, Cash Settings accepts the existing workbook ID, daily hour in WIB (default 02:00), and the enabled switch. Test Back Up Now and require an OK result before enabling the daily schedule. A configured path alone does not prove Google access. The server must be running; it retries failures after ten minutes and catches up after the scheduled hour. While it is down, no export occurs. A database lock prevents duplicate concurrent jobs across app instances.

The current integration synchronizes the existing annual tabs directly. It does not create `EMS Cash ...` tabs, add headers/columns (including hidden ID columns), or change the template layout. In existing yearly sheets, only literal transaction cells A2:E are writable. Headers, cell formatting, validation, notes, and all cells from column F onward stay unchanged. Formula cells inside A:E, such as the 2024 carryover, are also protected; a conflicting EMS change stops sync for reconciliation.

Initial binding compares each imported source row against the immutable import snapshot or current EMS values. Unknown, missing, moved or externally edited source rows block the write. Subsequent runs use a small sheet-level developer-metadata marker, invisible in the grid, to bind the EMS book and checksum the last input state and summary formulas. EMS entry IDs and source provenance drive the deterministic projection; no ID column is needed. Identical transactions remain separate. A repeat with no changes produces zero Google writes. A lost response after an applied batch is safe to retry. All books are planned and validated before one atomic Sheets batch.

Deleted/voided entries clear their input cells rather than deleting sheet rows or shifting the right-side summary. Their EMS audit remains intact. New records use the next mapped input row. New book opening balance is represented as a Cash Deposit row on January 1; it is never silently omitted from spreadsheet totals.

One EMS book per year maps to the tab named by its year. A missing year is created at the next manual/daily sync by duplicating the existing 2026 template (or the latest reviewed annual template), clearing old inputs and row-specific notes, then updating only the new copy's SUMMARY year and twelve month dates. Formulas, colors, widths, validation and header names are copied unchanged. Template duplication is ordered before any existing-year cell updates, preventing newly added old-year transactions from leaking into the new sheet. Unsupported templates, cross-sheet formulas in the new-year template, duplicate book years and foreign bindings stop the entire batch.

Fixed formula endpoints are a hard capacity boundary: the exporter stops before writing beyond the existing total/monthly ranges. It does not insert rows or extend formulas automatically. Changes to a source year referenced by a formula-backed carryover also require reconciliation first. Do not manually edit the destination while sync is running: the second read detects changes during planning, but Google Sheets has no conditional cell-write compare-and-swap. EMS is the source of truth, not a two-way sync.

This is a current-state spreadsheet mirror, not a complete disaster-recovery backup. Keep normal database/file backups for audit, deleted records and historical recovery. Existing obsolete `EMS Cash ...` tabs from the earlier exporter are not deleted automatically.

## Production rollout and rollback

1. Confirm actual production HEAD, running image, clean tracked files and container mounts. The remote `production-erf` branch may lag previously deployed feature branches; do not blindly pull it.
2. Fetch the feature branch and pin the tested full commit SHA. Extract `scripts/release-cash` from that exact commit.
3. Run `rehearse.sh SHA`. It builds tracked source outside the live checkout, restores an online production snapshot to an isolated database, runs dry-run/apply verification, starts the candidate with isolated staging settings, and checks copied documents. It sends no external mail and publishes no port. Require `REHEARSAL_OK`.
4. Run `cutover.sh SHA REHEARSAL_DIRECTORY` in a maintenance window. It captures active runtime settings, pauses the app, takes a fresh DB/document backup, proves restore and migration on a clone, then applies the additive migration and recreates only the app. The database container must remain unchanged. Runtime environment and document hashes are checked before reopening access.
5. Validate existing login, requests, PDF, My Requests/History and a representative Check → independent Review → Approve. Import the current cash snapshot and reconcile totals. Grant cash access explicitly. Configure and verify the daily backup.

The rollout prints a private backup directory and guarded rollback command. Before access is reopened, a failed cutover automatically restores the matching old app/database/files. After release, guarded rollback refuses to rewind if **any** business data, settings, cash entries, backup logs, or documents changed. Reconcile those changes first; never blindly restore an old snapshot over new transactions. Do not remove volumes or use `docker compose down -v`.

Adding a Google credential mount is a separate reviewed runtime change. The release scripts intentionally stop on extra/unrecognized mounts instead of silently discarding them in a later deployment.

## Verification

CI covers workflow transitions and concurrent decisions, checker/reviewer separation (including old records and manual takeover), active/approved visibility, login, existing upgrades, drafts, PDF wrapping, cash migration and import preservation, permissions/revocation, retry-safe saves, corrections/audit, exact balances and Google backup behavior using a stub. Browser checks cover desktop, 390 px and 320 px layouts, custom selects and mobile actions. Docker CI exercises rehearsal, successful cutover, injected-failure rollback, and refusing rollback after new data.

## Configure the existing Google Sheets backup

Verified workbook: https://docs.google.com/spreadsheets/d/13XAixuR71DH3SMZuZ1EGmdnTb49WKHRahmwfB2Kxekc/edit

The **Spreadsheet ID** field takes `13XAixuR71DH3SMZuZ1EGmdnTb49WKHRahmwfB2Kxekc` only. This is the segment between `/d/` and `/edit`, not a tab's numeric `gid`, Apps Script deployment ID, password or credential. The annual sheets 2023–2026 and Summary are the original template. No extra visible export tabs or columns are required.

1. In a company-controlled Google Cloud project, enable **Google Sheets API**. Enable Drive API too only if using `scripts/cash-snapshot.js` for a new source capture; scheduled export does not call Drive.
2. Create a service account for EMS backups. No project Owner/Editor role or domain-wide delegation is needed for sharing this particular workbook. If company policy permits JSON keys, create one under the service account's Keys → Add key → Create new key → JSON. Do not bypass an organization policy that disables keys.
3. Share the exact workbook with the JSON's `client_email` as **Editor**. Keep normal spreadsheet access restricted. Store the JSON privately on the VM outside the Git/build directory, for example `/srv/metrotech/secrets/ems-cash-google.json`, with permissions readable only by the app runtime and administrators. Do not paste the private key in chat or `.env`.
4. Mount that file read-only in app at `/run/secrets/ems-cash-google.json` and set `CASH_GOOGLE_KEY_FILE=/run/secrets/ems-cash-google.json`. Persist this in the production Compose configuration/override used for subsequent deployments. Recreate **app only**, preserving the actual running environment, PDF/signature mounts, image and networks. The current guarded release helpers deliberately reject additional mounts: update/review those helpers before a subsequent rollout; do not remove the credential mount to get around the check. Do not run a generic Compose recreate against stale `.env` settings.
5. In **Cash Settings → Daily Backup**, enter the Spreadsheet ID above and hour **2** (02:00 WIB). Initially leave the Daily Backup checkbox off and Save Settings. Click **Back Up Now** and require an `OK` run with matching annual inputs and preserved formulas. `Google credential: Configured` only means the environment path was set; it is not proof that the file, sharing or API access works.
6. Enable Daily Backup and Save Settings. No separate cron is needed: the app checks every minute, starts at/after the selected WIB hour, skips an already successful day and retries a failed attempt after ten minutes. The app must stay running. Verify another successful scheduled run the next day.

Before first live activation, test a separate workbook copy with the same EMS database identities, then select the original destination and reconcile it against the stored import snapshot. The development test copy uses synthetic book IDs and must not be configured as the production target. Credential installation/activation is a separate VM operation, not performed by a source-code update.

## Annual sync validation (2026-11-21)

Automated tests cover repeat/no-op, edit/delete, identical transactions, lost-response retries, stale external edits, foreign book bindings, duplicate years, capacity limits, formula-owned values, new-year opening balance and same-batch template isolation. Cash HTTP/database smoke retains access, audit, import preservation and daily scheduler/retry checks. Tests use isolated fixtures; no Google credential is required.

A separate native workbook copy was also tested with 923 imported source records: initial binding changed no cell values; a test transaction was added, edited and cleared in 2026; repeat planning produced zero writes; a 2027 sheet was duplicated with its own opening balance and transaction. Native reads verified all existing 2026 inputs returned to the original values and all copied cell formatting/validation and 62 formulas matched the template; the new-year total recalculated correctly. The original workbook was never written. Browser visual inspection required sign-in, so native cell/format metadata was used for verification; no visual restyling was performed.

Google references: https://developers.google.com/workspace/guides/create-credentials and https://developers.google.com/workspace/guides/enable-apis . No real credential or external Google write is included in automated tests.
