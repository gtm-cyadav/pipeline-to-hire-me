# GTM Scoring Console

An interactive CV that scores the person reading it.

I built a [lead scoring pipeline](https://github.com/gtm-cyadav/gtm-lead-scoring) for a GTM team — PostgreSQL, a logistic regression model, a Slack bot that fires on hot leads. This page is that system, pointed at whoever opens it.

The visitor is the lead. They get ingested, enriched, scored and routed. Along the way the CV underneath re-ranks and rewrites itself for whichever role they say they're hiring for.

**Hosting:** it is a static site. To serve it from GitHub Pages: Settings → Pages → Deploy from `main`, root.

## How it works

| Stage | What happens |
|---|---|
| 01 Ingest | A lead record is created on page load — session id, source, device, `days_since_engagement: 0` |
| 02 Enrich | The visitor fills in seniority, company size and intent, and picks the role they're hiring for. Each field shows its coefficient |
| 03 Score | Logistic regression: `p = 1 / (1 + exp(-z))`, MQL threshold at `p ≥ 0.70`. The SQL and Python panes rewrite themselves with the visitor's live values |
| 04 Match | Six evidence records ranked by relevance to the selected role, with the bullets and skill chips filtered to that role |
| 05 Route | Crossing the threshold fires a Slack-style alert; the handoff button opens a mail draft with the whole scored record in it |

### The model

Five features, fitted the same way as the production pipeline — check which signals predict conversion in SQL first, then fit a logistic regression so every score can explain itself.

```
z  = -3.20                      # intercept
z += seniority                  # ≤ 1.60
z += company_size               # ≤ 1.00
z += intent                     # ≤ 1.40  (strongest single predictor)
z += engagement_depth           # ≤ 2.40  (sections opened, links, dwell, scroll)
z += recency                    #   0.90  (engaged today)

p = 1 / (1 + exp(-z))
```

Feature contributions are shown live in the right rail, so the score is never a black box.

### Role tracks

Growth / GTM · Performance marketing · Brand & content · Market research & insights · E-commerce / D2C · Data & analytics

Same facts, argued for the job in front of them. Each evidence bullet and skill chip is tagged with the roles it's relevant to, and each record carries a per-role match score that drives the ordering.

## Running it

The page is one HTML file with no build step and no dependencies. The fonts sit next to it in `fonts/`, so it makes no third-party requests.

```bash
open index.html
```

### Print and no-JS version

The page also carries a plain static CV (`<article id="cv">`). It is hidden on screen, and it is what prints ("Save CV as PDF" in the Route stage), what shows with JavaScript off, and what a crawler reads. It is generated from the same `EVIDENCE` data the page renders, so there is no second copy to keep in step:

```bash
node tools/build-cv.mjs           # rewrite the block after editing the page data
node tools/build-cv.mjs --check   # exit 1 if it is out of date
```

`og.png` is the link-preview image (rendered from `tools/og-card.html` with `node tools/render-og.mjs`, which needs Playwright). The `og:` and `canonical` URLs in `<head>` assume the site is served at `https://gtm-cyadav.github.io/pipeline-to-hire-me/`; change them if it lives elsewhere.

## Lead capture

Scoring runs entirely in the browser — no analytics, no cookies, no tracking, no third-party requests. Nothing is sent anywhere unless the visitor presses a button that says it will be.

There are two send paths:

- **Mail handoff** — always on. Opens the visitor's own mail client with the scored record written into the draft.
- **Leave this record** — appears only once `CAPTURE_ENDPOINT` is set in `index.html`. Posts the record to a Google Sheet. See [`capture/README.md`](capture/README.md) for the five-minute setup; the Apps Script is in [`capture/Code.gs`](capture/Code.gs).

To route to Slack instead, point `CAPTURE_ENDPOINT` at an n8n webhook rather than the Apps Script URL — same payload, no code change — which closes the loop and makes this a live instance of the pipeline it's imitating.

## Stack

Vanilla HTML, CSS and JavaScript, with Spectral, Archivo and IBM Plex Mono self-hosted from `fonts/`. No framework, no build step.

### Accessibility

- Text colours clear 4.5:1 on every panel in both the light and dark themes. The status colours have separate text-safe variants (`--hot-t` and friends); the plain ones are only used for fills.
- The live score is deliberately not a live region, because it animates and drifts with scroll and time. A screen reader hears the score when the status changes or after a form change, and hears the Slack-style alert when it fires.
- Skip link, labelled event log, and a pipeline position label that tracks the stage you are in.

---

Chetan Yadav — Delhi, India
[chetan00yadav@gmail.com](mailto:chetan00yadav@gmail.com) · [github.com/gtm-cyadav](https://github.com/gtm-cyadav)
