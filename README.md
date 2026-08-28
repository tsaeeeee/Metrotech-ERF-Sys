# Metrotech ERF — Google Apps Script

Google Workspace-native implementation of the Metrotech 3-layer Expense Request workflow.

## Workflow

Requestor → Reviewer (**Dimas Jenar**) → Approver (**Ervan Mardianto**).

- Every payment requires evidence before it can be added.
- Browser merges all payment evidence into one PDF on submission.
- Requestor signature is attached automatically to Prepared By.
- Reviewer can approve or reject; rejection requires a reason.
- Reviewer signature is attached automatically on approval.
- Approver can approve or reject; rejection requires a reason.
- Approver signature is attached automatically on final approval.
- Final approval automatically emails the final Form PDF + Evidence PDF.
- Rejected requests keep the same ERF reference number and increment the revision.

## Files

- `Config.gs`
- `Code.gs`
- `Index.html`
- `Styles.html`
- `Client.html`
- `appsscript.json`

## One-time setup

1. Create a standalone Apps Script project under a Metrotech Workspace automation/admin account.
2. Copy all files from this branch.
3. Run `setupSystem()` once.
4. Open the generated **Metrotech Expense Approval System Data** spreadsheet.
5. Populate the `Employees` sheet:

| Email | Name | Employee ID | Department | Location | Division | Role | Signature File ID | Active |
|---|---|---|---|---|---|---|---|---|

Roles: `REQUESTOR`, `REVIEWER`, `APPROVER`.

The active REVIEWER named **Dimas Jenar** and active APPROVER named **Ervan Mardianto** are fixed workflow actors.

Signature File ID must point to a private PNG/JPG in Google Drive. Do not commit signature images to GitHub.

## Official template

Spreadsheet ID is already configured to the ERF template supplied for the project.

Current template mapping:

- Request Date → G3
- Ref No → G4
- Name → D9
- Employee ID → D10
- Department → D11
- Location → D12
- Division → D13
- Payment rows → 16–31
- Total → G32
- Prepared By → B37
- Reviewed By → E37
- Approved By → F37

Reference format: `ERF-YYYY-MMDD-0001`.

## Deploy

Deploy → New deployment → Web app.

For the prototype, choose a Workspace deployment mode that exposes the signed-in employee identity through `Session.getActiveUser().getEmail()`. The exact production identity/storage permission model will be locked during deployment planning.

Set `CFG.ALLOWED_DOMAIN` once the exact Workspace domain is confirmed.

## Notification

Workflow notifications are system-generated. The code uses Apps Script MailApp and requests no-reply behavior for Workspace-supported deployments.
