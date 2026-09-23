# cdc-scraper

Watches the [CDC test date page](https://www.cdc.com.sg/test-date/) and sends a Telegram
message when a watched test date changes.

Default watch: **School Learners → "Class 3A Practical Test for Auto Car - C3A"**
(currently `20 Oct 2026`).

---

## How the page actually works

Worth knowing before changing anything, because it drives every design decision here.

1. **The table is not in the HTML.** The page ships empty and jQuery fetches
   `https://enrol.cdc.com.sg/wscdctestdate/api/testdate/` on load, then renders the
   three tables into `#testdate`.
2. **The whole site is behind a Cloudflare WAF that fingerprints TLS, not headers.**
   `curl` → 403. `curl` with a full set of real browser headers → 403. Node `fetch` → 403.
   Hitting the JSON API directly, from any HTTP client → 403. Adding headers does not
   help, because the block is on the TLS handshake, not on what you claim to be.
3. **A real browser passes.** Headless Chrome via Playwright gets a clean 200.

So the scraper drives headless Chrome, loads the page, waits for the XHR-rendered
table, and reads the DOM. That is the only path that works.

### Two things that are load-bearing

Both were found by testing against the live site, and both look like harmless
optimisations you would want to make later. Don't.

| Do | Don't | Why |
|----|-------|-----|
| `chromium.launch()` + `newContext()` | `launchPersistentContext()` | A persistent context is reliably 403'd; a normal launch passes. |
| A fresh context with an empty cookie jar every run | Saving and replaying cookies | Replaying a stored `cf_clearance` into a new session gets 403'd — that cookie is bound to the session that earned it. |

Both are commented in [`src/scrape.mjs`](src/scrape.mjs).

---

## Setup

```sh
npm install
npx playwright install chrome     # uses your real Chrome; skip if already installed
cp .env.example .env
```

Then get Telegram credentials:

1. Telegram → talk to **@BotFather** → `/newbot` → copy the token into `.env`.
2. Send your new bot any message (a bot cannot message you first).
3. `npm run telegram:chatid` → copy the printed id into `.env`.
4. `npm run telegram:test` → you should receive a message.

Finally, record the current date without firing an alert:

```sh
npm run seed
```

## Commands

| Command | What it does |
|---------|--------------|
| `npm run check` | Scrape, compare, notify on change. The real run. |
| `npm run check:dry` | Scrape and compare, but never write state or send. Safe to run anytime. |
| `npm run seed` | Record current values without alerting. Use on first setup. |
| `npm run telegram:test` | Verify Telegram wiring. |
| `npm run telegram:chatid` | Print chat ids your bot can see. |
| `npm run schedule:install` | Install the hourly macOS launchd job. |
| `npm run schedule:uninstall` | Remove it. |

## What gets stored

`state.json` — and yes, the date is essentially the only thing that matters:

```json
{
  "watched": {
    "c3a": { "date": "20 Oct 2026", "day": "Tuesday", "description": "...", "seenAt": "..." }
  },
  "lastCheckedAt": "...",
  "lastChangedAt": "...",
  "consecutiveFailures": 0
}
```

The extra fields are for debugging, not logic. `consecutiveFailures` is what stops a
silent death: after 3 failed runs in a row you get a Telegram warning, so a WAF block
can't quietly stop the monitor for a week without you noticing.

**Alerts are sent before state is written.** If Telegram is down, the old date stays in
`state.json`, so the next run sees the change again and retries the alert. A change is
never swallowed.

## Watching more rows

Add to `WATCHED` in [`src/config.mjs`](src/config.mjs). Everything downstream already
loops over the list:

```js
{ id: 'c3', section: 'SCHOOL LEARNERS',
  description: 'Class 3 Practical Test for Manual Car - C3',
  label: 'Class 3 Practical (Manual) — C3' },
```

Matching normalises whitespace, dash characters and case, so minor copy edits on the
site won't silently break the match. If a watched row disappears entirely, the run logs
a `WARN` rather than treating it as a change.

---

## Not getting blocked

The honest version: **the single biggest factor is that you are making 12 requests a
day.** That is nothing. No amount of clever randomisation matters next to request
volume, and most "anti-detection" tricks make you look *more* automated, not less.

What this repo does:

- **Random delay after the hour.** The job fires at `:00` and then sleeps a random
  0–15 minutes before touching the site, so you are not hitting it on a robotic
  schedule alongside every other cron on the internet.
- **Real Chrome, not bundled Chromium** (`channel: 'chrome'`), so the TLS and JS
  fingerprint is a genuine browser's.
- **Small viewport variation, a short pause, a mouse move and a scroll** before reading.
- **A consistent, truthful User-Agent.** Deliberately *not* rotated. A rotating UA that
  disagrees with the actual browser fingerprint is a classic bot signal — rotation helps
  only when you are also rotating IPs, which you are not.
- **Exponential backoff with jitter** between the 3 attempts in a run, and the run gives
  up rather than hammering. When a WAF soft-blocks you, retrying fast is how it becomes
  a hard block.

What it deliberately does *not* do: proxy rotation, TLS impersonation, stealth plugins.
For 12 polite requests a day to a public page, that would be solving a problem you
don't have.

## Captchas

Right now there is **no captcha** — the site uses a Cloudflare WAF rule that blocks
non-browser clients outright, which real Chrome simply passes. In several dozen test
runs, zero challenges appeared.

If that changes, `looksBlocked()` in [`src/scrape.mjs`](src/scrape.mjs) already detects
the challenge and block interstitials ("Just a moment…", "Verify you are human",
"Sorry, you have been blocked"). The response is to **back off and tell you**, not to
try to break through:

- An invisible JS challenge is usually passed by real headless Chrome on its own.
- An interactive challenge means the site is asking for a human, and the right move is
  to lower frequency or check manually — not to bolt on a solver. Captcha-solving
  services are also where a harmless personal monitor turns into something the site
  owner would reasonably object to.

After 3 consecutive failures you get a Telegram warning naming the cause, so you'll know
to look.

---

## Infrastructure

### Recommended for a POC: this Mac, via launchd

```sh
npm run schedule:install
```

Runs at `:00`, hourly from 08:00–19:00 local time, each run jittered 0–15 min.

```sh
launchctl list | grep cdc                 # confirm loaded
launchctl start com.cdc.testdate-monitor  # run once now
tail -f logs/cdc.log                      # watch it
npm run schedule:uninstall                # remove
```

Why this first: it costs nothing, needs no accounts, and — importantly — it runs from a
**residential IP, which is already proven to work against this WAF.** The catch is that
your Mac has to be awake; launchd will run a missed job on wake, so you may get a late
check rather than none.

### The serverless option: GitHub Actions

[`.github/workflows/check.yml`](.github/workflows/check.yml) is written and ready. This
is the closest thing to serverless that fits the constraints: no server to run or patch,
cron built in, secrets management built in, free for this volume, and `state.json` is
persisted by committing it back to the repo.

To use it: add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` under
**Settings → Secrets and variables → Actions**, then trigger it once manually via
**Actions → CDC test date check → Run workflow**.

⚠️ **Verify that manual run before relying on it.** GitHub runners use Azure datacenter
IP ranges, and Cloudflare scores those far more harshly than a residential IP. The
browser fingerprint will be fine; the IP reputation might not be. If the run comes back
403, that is what happened — and it is the single reason the local option is recommended
first. Two other quirks: scheduled runs on free runners are often delayed several
minutes under load (harmless here — it is extra jitter), and GitHub disables schedules
on repos with no activity for 60 days.

### Why not "real" serverless (Lambda / Cloud Run / Cloud Functions)?

It's doable but it is the worst fit of the three:

- You need a headless browser, so you are shipping a ~250MB container image with
  Chromium in it, not a 2KB handler. Cold starts run into seconds.
- Lambda's bundled Chromium (`@sparticuz/chromium`) is *not* the real Chrome build this
  scraper relies on, so the Cloudflare result is unverified — it may well be blocked.
- Same datacenter-IP reputation problem as GitHub Actions, on worse-regarded ranges.
- You'd need somewhere to keep `state.json` (DynamoDB, S3, or a parameter), which is
  more moving parts than a file.

For **12 requests a day**, the serverless win (elastic scale, pay-per-invoke) buys you
nothing, and the browser requirement takes away everything that makes serverless pleasant.

### Summary

| Option | Cost | IP reputation | Effort | Verdict |
|--------|------|---------------|--------|---------|
| **macOS launchd** | free | residential — **verified working** | already written | Local fallback |
| **GitHub Actions** | free | Azure — **verified working** | already written | Manual fallback (timer disabled) |
| Small VPS + cron | ~$5/mo | datacenter, but a stable IP you own | provision + maintain a box | Only if Actions is blocked |
| **AWS Lambda + EventBridge** | ~free | AWS — **unverified** | container image + CDK | **Current target** — see below |


---

# The AWS path (Lambda + EventBridge Scheduler)

Monitoring is moving from GitHub Actions to AWS. The Actions **timer is disabled**
(`workflow_dispatch` only), so it stays available as a one-click manual fallback
without running on its own.

## Why move

GitHub cron is best-effort: scheduled runs are queued at low priority, routinely
delayed 5-20 minutes, and can be dropped entirely under load. EventBridge Scheduler
fires reliably, understands `Asia/Singapore` natively (no UTC arithmetic, no second
cron entry to stop the last run spilling past 19:00), and its **flexible time window**
randomises each invocation for free — which replaces the in-process jitter sleep
entirely. On Lambda that matters: sleeping costs GB-seconds.

## Architecture

```
EventBridge Scheduler  ──invoke──>  Lambda (container: Node 22 + real Chrome)
  cron(0,30 8-19 ? * * *)                    │
  tz Asia/Singapore                          ├──> DynamoDB   (state, one item)
  flexible window: 15 min                    ├──> SSM Params (Telegram creds)
                                             └──> Telegram API
```

| Piece | Choice | Why |
|---|---|---|
| Compute | Lambda **container image** | Chrome will not fit in a 250MB zip |
| Architecture | **x86_64**, not arm64 | Google ships no ARM build of Chrome for Linux |
| Memory | 2048 MB | Chrome is memory-hungry; Lambda CPU scales with memory, so less memory buys a slower run, not a cheaper one |
| State | DynamoDB, one item | Read and written as a unit; keeps writes atomic at one RCU/WCU |
| Secrets | SSM SecureString | Free. Secrets Manager charges $0.40/secret/month for no benefit here |
| Jitter | EventBridge flexible window | Free, vs. paying Lambda to `setTimeout` |

### Code layout after the refactor

`src/monitor.mjs` holds the compare/notify/persist logic and knows nothing about
where state lives — callers pass a store. So one implementation serves both paths:

```
src/monitor.mjs          shared logic  (store-agnostic)
src/scrape.mjs           shared scraper
src/stores/file.mjs      JSON file   -> CLI + GitHub Actions
src/stores/dynamodb.mjs  DynamoDB    -> Lambda
src/check.mjs            CLI entrypoint
lambda/handler.mjs       Lambda entrypoint
lambda/Dockerfile        Node 22 + real Chrome
infra/                   CDK (TypeScript)
```

## Build it in this order

The whole thing hinges on one untested question: **does Cloudflare accept traffic
from a Lambda egress IP?** AWS ranges are the most scraper-saturated on the internet.
Find out before building the rest.

| Step | Command | Gate |
|---|---|---|
| 1 | `docker buildx build --platform linux/amd64 -f lambda/Dockerfile -t cdc-lambda .` | image builds |
| 2 | run locally via Lambda RIE (below) | Chrome starts in-container |
| 3 | `cdk deploy`, then invoke manually | ⬅ **go/no-go on Cloudflare** |
| 4 | confirm the schedule fires | done |

If step 3 returns a `BlockedError`, stop. The fix is a NAT Gateway with an Elastic
IP at ~$32/month, which costs more than everything else combined.

## What to configure — CLI

**1. Credentials** (currently invalid on this machine — `aws sts get-caller-identity`
returns `InvalidClientTokenId`):

```sh
aws configure sso            # preferred; or `aws configure` with an IAM user key
export AWS_REGION=ap-southeast-1
aws sts get-caller-identity  # must print your account before going further
```

**2. Store the Telegram credentials** as encrypted parameters. These are created by
you, not by CDK — secrets in a CloudFormation template are readable in plaintext.

```sh
aws ssm put-parameter --name /cdc-scraper/telegram-bot-token \
  --type SecureString --value 'PASTE_TOKEN' --region ap-southeast-1

aws ssm put-parameter --name /cdc-scraper/telegram-chat-id \
  --type SecureString --value 'PASTE_CHAT_ID' --region ap-southeast-1
```

**3. Bootstrap and deploy:**

```sh
cd infra
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-southeast-1   # once per account+region
npx cdk deploy
```

`bootstrap` creates the S3 bucket and ECR repo CDK uses for assets. The first
`deploy` cross-builds the x86_64 image on your Mac (emulated, slow) and pushes it.

**4. Seed state, then test** (function name comes from the stack output):

```sh
FN=$(aws cloudformation describe-stacks --stack-name CdcScraperStack \
      --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text)

aws lambda invoke --function-name $FN --payload '{"seed":true}' --cli-binary-format raw-in-base64-out /dev/stdout
aws lambda invoke --function-name $FN /dev/stdout        # the real go/no-go
```

A `BlockedError` in the response means Cloudflare rejected the Lambda IP.

**Test the image locally first** (no AWS needed), using the Lambda Runtime Interface
Emulator built into the base image:

```sh
docker run --rm -p 9000:8080 --platform linux/amd64 \
  -e STATE_TABLE=dummy cdc-lambda
curl -s "http://localhost:9000/2015-03-31/functions/function/invocations" -d '{"dryRun":true}'
```

This proves Chrome starts in the container. It does **not** test the Lambda IP —
it exits from your home connection.

## What to configure — Console

CDK creates the infrastructure, so the console is mostly for the things that
shouldn't live in code:

1. **IAM Identity Center** — create the user/permission set backing `aws configure sso`,
   if you haven't already. (Only needed once.)
2. **Billing → Budgets** — set a $1 budget with an email alert. Everything here fits
   the free tier, so any spend at all means something is wrong (most likely a NAT
   Gateway). Do this *before* deploying.
3. **CloudWatch → Log groups** → `/aws/lambda/CdcScraperStack-CheckFunction...` —
   where scrape output and `BlockedError`s appear. This is your debugging surface.
4. **EventBridge → Scheduler → Schedules** — confirm the schedule shows
   `Asia/Singapore` and the 15-minute flexible window, and check *Next trigger*.
5. **DynamoDB → Tables → Explore items** — see the stored date directly.

Nothing else needs touching; IAM roles, the table, the function and the schedule are
all created by `cdk deploy`.

## Cost

Free, or close to it: ~23 invocations/day at 2GB for ~30s is roughly 41k GB-seconds
a month against a 400k free-tier allowance; EventBridge Scheduler's first 14M
invocations are free; DynamoDB on-demand at ~46 ops/day is negligible; SSM standard
parameters are free. The only thing that would cost real money is a NAT Gateway
(~$32/month), which you'd only add if Lambda's egress IP turns out to be blocked.
