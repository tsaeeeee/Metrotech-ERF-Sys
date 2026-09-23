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
through `sql/migrations/016-ems-claim-flow.sql` before starting the updated
app. New volumes use `sql/schema.sql`. In particular, migrations 015 and 016
are needed for the ECF source ERF link, form access, and ECF numbering.

An ECF is a separate request linked to one approved ERF owned by its requestor.
Each active pending or approved ECF reserves its claim amount; rejected or
recalled ECFs release it. Claims pass through Checker, Reviewer and Approver.
The payment profile is copied into the ECF at submission, preserving the
historical bank details when the profile later changes.

The Dashboard shows approved ERF and ECF totals by request month. Its
"Approved ERF minus claimed" value is an overview of approved transactions,
while each source ERF's precise available balance is shown on the ECF form.
