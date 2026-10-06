# Lead capture setup

Turns the "Leave this record" button on the site into rows in a Google Sheet. Five minutes, no third-party account, no cost.

Until `CAPTURE_ENDPOINT` in `index.html` has a URL in it, the button stays hidden and the site sends nothing.

## 1. Make the sheet

Create a new Google Sheet. Name it something like **GTM Console — leads**. Leave it empty; the script creates the tab and headers on the first submission.

## 2. Add the script

In that sheet: **Extensions → Apps Script**. Delete whatever is in `Code.gs` and paste the contents of [`Code.gs`](Code.gs). Save.

## 3. Deploy it

**Deploy → New deployment → Select type → Web app**, then:

| Field | Value |
|---|---|
| Description | `capture v1` |
| Execute as | **Me** |
| Who has access | **Anyone** |

Click **Deploy**. Google asks you to authorise it — it's your own script writing to your own sheet, so approve it. On the "Google hasn't verified this app" screen, choose **Advanced → Go to (project name)**.

Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.

"Anyone" means anyone who knows that URL can send it a request, and the URL is in the page source, so assume it is known. It cannot read the sheet. See [Abuse protection](#abuse-protection) for what the script does about that. If it ever gets abused anyway, create a new deployment, point `CAPTURE_ENDPOINT` at its URL, then archive the old deployment (**Deploy → Manage deployments → Archive**). Creating a new deployment alone does not stop the old URL working.

## 4. Wire it into the site

In `index.html`, near the top of the script block:

```js
var CAPTURE_ENDPOINT = "https://script.google.com/macros/s/AKfy…/exec";
```

Commit and push. GitHub Pages redeploys in a minute or two.

## 5. Check it

Open the live site, fill in the enrichment fields, scroll to **05 Route** and press **Leave this record**. A row should appear in the sheet within a second or two.

Opening the web app URL directly in a browser returns `{"ok":true,...}` — a quick way to confirm the deployment is alive.

## What gets stored

One row per submission: timestamp, lead_id, name, email, company, seniority, company size, intent, role track, score, probability, engagement depth, source, device, and the optional note.

Nothing is sent unless the visitor presses the button, and the page says so in its footer. Keep it that way — silently logging what people type would contradict a promise the page makes to its readers.

## Abuse protection

Every request is treated as hostile. Before anything is written, the script:

- refuses bodies over 8 KB, anything that is not a JSON object, and a `lead_id` that is not plain letters, digits, `_` or `-`;
- keeps only the fifteen known fields, as text capped at the same lengths the page uses (note 800, name and company 60, email 120, and so on), with control characters removed;
- turns `score`, `probability` and `engagement` into real, clamped numbers. A value that is not numeric is stored as blank, so none of them can reach the sheet as a formula;
- stores any text that starts with `=`, `+`, `-` or `@` as plain text, again so nothing is ever evaluated as a formula. This matters because the sheet holds other people's email addresses;
- drops a malformed email rather than using it as the reply-to.

It also rate-limits, because it cannot see who is calling:

| Limit | Default | When it is hit |
|---|---|---|
| Rows per hour, all visitors | 20 | request refused (`rate_limited`) |
| Submissions per `lead_id` per 6 hours | 3 | request refused (`rate_limited`) |
| Emails per day | 40 | row is still stored, the email is skipped |
| Rows in the sheet | 5,000 | request refused (`full`) |

Change them in the `LIMITS` block at the top of `Code.gs`, then redeploy.

The honest trade-off: the limits are global, so a determined flood can use up the hourly allowance and turn real visitors away for that hour. When that happens the page tells them the send failed and points them at the mail handoff, so nobody is stranded, but you will not see their row. Failures return only a short code (`bad_request`, `too_large`, `rate_limited`, `busy`, `full`, `server_error`); the detail goes to the script's own log (**Executions** in the Apps Script editor), never back to the caller.

### Tests

The script's logic runs in Node with the Apps Script services stubbed, so you can check changes before deploying:

```bash
node --test capture/Code.test.mjs
```

## Email notifications

`Code.gs` emails `NOTIFY_EMAIL` on every new lead, subject line `Lead 84/100 — Priya Raman @ Northwind Labs`. When the visitor left an email address it's set as the **reply-to**, so replying in Gmail goes straight to them.

Set `NOTIFY = false` at the top of the script to turn this off and keep sheet rows only.

The row is written before the email is attempted, and a mail failure is caught and logged rather than failing the request — a bounced notification never costs you the lead.

Consumer Gmail accounts can send 100 script emails a day, which is far more than this page will ever generate.

## Updating the script later

Editing `Code.gs` is not enough — Apps Script serves the last *deployed* version. After any change:

**Deploy → Manage deployments → pencil icon → Version: New version → Deploy**

Keep the same deployment so the `/exec` URL never changes. Creating a *new deployment* instead issues a new URL and the site would keep posting to the old one.

Adding email notifications introduces a new permission (sending mail as you), so Google will ask you to authorise the script once more on the next deploy.
