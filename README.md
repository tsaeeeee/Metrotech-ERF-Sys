# Metrotech Expense Management System

Internal expense request and claim approval system for Metrotech Indonesia.

The repository includes these implementations:

- `appscript` branch — Google Apps Script + Google Workspace
- `web` branch — standalone web application + PostgreSQL + Docker

ERF workflow: Requestor → Reviewer → Approver.
ECF workflow: Requestor → Checker → Reviewer → Approver.

## EMS development

The `web` branch contains the ERF and ECF modules. Production ERF is maintained
on the separate `production-erf` branch.

For an **existing** PostgreSQL volume, apply the SQL migrations in sequence
through `sql/migrations/017-independent-erf-access.sql` before starting the updated
app. New volumes use `sql/schema.sql`. Migrations 015 and 016 add ECF form
access, roles, and numbering.
For a volume already at migration 016, apply only migration 017 before rebuilding
the app. Migration 017 adds ERF No Access for ECF-only Requestors and Checkers.

An ECF is a separate claim and does not require an approved ERF. New ERF
submissions use Expense Request only; historical reimbursement requests remain
available for viewing and revision. Existing ECF source links remain stored
for historical records, but do not restrict new claims or claim revisions.
Claims pass through Checker, Reviewer and Approver.
The payment profile is copied into the ECF at submission, preserving the
historical bank details when the profile later changes.

The Dashboard shows separate approved ERF and ECF totals by request month.
