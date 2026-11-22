# Connecting the office cash workbook

The office workbook and the testing copy can contain the same transactions at
different rows. Deleted EMS records reserve positions, so row numbers alone are
not transaction identities.

On the first connection, legacy records must still match their imported row or
the current EMS values. A populated non-legacy row is accepted only when exactly
one active EMS record matches its date, category, activity, income and outcome.
Repeated identical records are ambiguous and stop the entire sync. Unknown rows,
different amounts and changed legacy descriptions also stop the sync.

Accepted EMS IDs retain their office row positions in sheet developer metadata.
This adds no worksheet columns, headers, formulas or formatting. Deleted records
receive reserved empty positions; future entries append after all saved
positions. Existing workbook bindings without this mapping retain their former
positions when upgraded. No database migration is involved.

Before enabling writes to the office workbook:

1. Pause Daily Backup while reconciling the destination.
2. Remove the known test transaction through Cash Tracker, preserving its audit.
3. Reconcile the Agista legacy description using the office text through EMS Edit.
4. Run `node scripts/cash-sheet-precheck.js SPREADSHEET_ID` using the candidate
   code and live read-only snapshot. It uses read-only SQL and Google scopes.
5. Review target identity, row mappings and every proposed cell change. If all
   transactions already exist unchanged in the office workbook, only metadata
   operations should be needed and CELL_WRITES must be zero.
6. Preserve the current runtime environment and all three production mounts when
   deploying, including the Google credential mount. Do not use the old two-mount
   cash cutover helper unmodified. Enable the schedule after manual verification.

EMS remains the writing authority after binding. External edits stop future
syncs; this is not two-way synchronization. Do not silently reconcile ongoing
Telegram/manual writes by changing the metadata checksum.

After a workbook has an `entryRows` mapping, keep this mapper (or a compatible
newer version) in any app rollback. Older sync code does not understand the row
mapping and could relocate transactions. Disable Daily Backup before reverting
to an incompatible application image; do not run manual backup from that image.

Isolated regression check: `node scripts/cash-sheet-sync-smoke.js`.
