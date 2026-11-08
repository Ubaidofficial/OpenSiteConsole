# SEOConsole Cloud: the control app for the hosted $9 plan

SEOConsole is free to **self-host**. This folder is the small separate program that sells a **hosted** option: a visitor pays $9 a month and gets their **own private instance** (their own copy of the app and their own database), created automatically.

> **Status: built and tested against fakes, never run against a real Stripe account, Coolify server or Google review.** Webhook verification, the request shapes for Stripe and Coolify, the provisioning state machine and the HTTP server are covered by 45 tests (mutation-checked), and the built program was started and answered requests. Every call to Stripe and Coolify was written from their documentation; **expect to debug first contact**, and do the first run in Stripe's **test mode**. Read "What is not built or not verified" before taking money from anyone.

## How it works
```
visitor ──▶ control app (cloud.example.com)
              │ 1. sign-up form: email + a password for their instance (stored only as a scrypt hash)
              │ 2. Stripe Checkout (hosted by Stripe) for the $9 subscription
              ▼
          Stripe ──webhook──▶ control app ──Coolify API──▶ Coolify on your server
                               checkout.session.completed      creates one app per customer from compose.coolify.yaml,
                               subscription updated/deleted     sets its settings, domain c-xxxxxxxx.cloud.example.com, deploys
customer ──▶ https://c-xxxxxxxx.cloud.example.com   (their own SEOConsole, their own SQLite file)
Google sign-in ──▶ control app /oauth/callback ──▶ back to that customer's instance (one shared redirect address)
```
Why one instance per customer: it reuses the whole app, and one customer's data can never be reached from another's. The cost is some server memory per customer.

## What happens over a customer's life
| Event | What the control app does |
|---|---|
| Checkout paid | Creates the customer, then (retrying until it works) creates the Coolify app, stores its 6 settings, sets the domain, deploys, and marks it active when `/login` answers |
| Payment fails (`past_due`) | Keeps the instance **running** for `CLOUD_GRACE_DAYS` (7), then stops it |
| Payment recovers | Back to active (starts it again if it was stopped) |
| Cancelled / unpaid | Stops the instance at once and keeps its data `CLOUD_RETENTION_DAYS` (30) |
| Retention over | **Deletes the instance and its data only if `CLOUD_ALLOW_DESTROY=1`**; off by default |
| Customer returns inside the window | The instance is started again with its data |

Stripe may deliver events twice or out of order. Events are recorded by id (a crash mid-way means the event is handled again), a subscription event that arrives before its checkout event is answered with an error so Stripe redelivers it, and every provisioning step is recorded so a retry resumes instead of duplicating.

## Setup (all of it is yours to do; I have no access to any of these accounts)
1. **A domain** and DNS: `cloud.example.com` (the control app) and a wildcard `*.cloud.example.com` pointing at the Coolify server. Customers live at `c-xxxxxxxx.cloud.example.com`.
2. **Stripe**, in *test mode* first:
   - Create a product with a **recurring monthly price of $9**; note the `price_...` id.
   - Add a webhook endpoint `https://cloud.example.com/stripe/webhook` for **these four events**: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy its `whsec_...` signing secret.
   - A restricted API key is enough: it needs write access to **Checkout Sessions** (and Customer portal sessions if you add the billing link later).
3. **Coolify**: turn on the API (Settings), create a token with `write` and `deploy` permissions, and note the **project UUID** and the **server UUID** where customer apps should run. (The token can create and delete apps on that server: keep it only in the control app.)
4. **Google**: use ONE OAuth client for all customers. Add `https://cloud.example.com/oauth/callback` as its only redirect address. Hosted customers will sign in with Google, so the app will need Google's OAuth verification (see below).
5. **Run the control app** (it needs the settings below). With Docker, from the repo root: `docker build -f cloud/Dockerfile -t osc-control .` and run it with a volume on `/data`; or on Coolify as a second resource from this repo using `cloud/Dockerfile`. Or without Docker: `pnpm cloud:build && pnpm cloud:start`.
6. In Stripe test mode, sign up with a test card (`4242 4242 4242 4242`), watch `/welcome`, open the instance, and sign in with the password you chose. Test a failed payment and a cancellation before going live.

## Settings (environment variables; the app refuses to start if any required one is missing or malformed)
| Variable | Meaning |
|---|---|
| `CLOUD_BASE_URL` | Public address of the control app, https (no trailing slash) |
| `CLOUD_INSTANCE_DOMAIN` | `cloud.example.com`: customers get `<slug>.<this>` |
| `CLOUD_SECRET_KEY` | 32+ random characters. Every instance's `APP_SECRET` is derived from it, so **never change or lose it** (it is what lets you recover or move an instance) |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | From step 2 |
| `COOLIFY_URL`, `COOLIFY_TOKEN`, `COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID` | From step 3 (`COOLIFY_ENVIRONMENT` defaults to `production`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The shared OAuth client; given to every instance |
| `CLOUD_REPO_URL`, `CLOUD_REPO_BRANCH`, `CLOUD_COMPOSE_LOCATION` | What each instance runs (defaults: this repo, `main`, `/compose.coolify.yaml`) |
| `CLOUD_GRACE_DAYS` (7), `CLOUD_RETENTION_DAYS` (30) | The two periods above |
| `CLOUD_ALLOW_DESTROY` | `1` to let it delete instances and their data after retention. **Off by default.** |
| `CLOUD_PRICE_LABEL` | Text shown on the page (the real price is the Stripe price): `$9 / month` |
| `CLOUD_DB_PATH`, `PORT`, `CLOUD_TRUST_PROXY` | Database file (`./cloud-data/cloud.db`), port (8080), and `1` to read the visitor's address from the last `X-Forwarded-For` entry when it sits behind exactly one trusted proxy |

## Security notes
- **Passwords:** a customer's instance password is hashed (scrypt) the moment they submit it; the plain password is never stored, logged or sent to Coolify (instances get `ADMIN_PASSWORD_HASH`). The hash is deleted from the control database once the instance has it, and unpaid sign-ups are purged after 2 days.
- **Webhooks:** the signature is checked as Stripe documents (HMAC-SHA256 over `timestamp.body`, constant-time compare, 5-minute window, only `v1`), on the raw body, before anything is read from it.
- **Secrets:** the Coolify token and Stripe key live only in this program's environment. Instance settings are stored in Coolify as literal, hidden-after-saving values. Errors from Stripe and Coolify are shortened and never contain keys.
- **OAuth relay:** `/oauth/callback` forwards only to `https://<slug>.<your domain>` for a customer that exists and is running, and passes on only Google's own parameters. It is not an open redirect.
- **Abuse:** sign-up is limited to 5 started payments per visitor per hour, bodies are size-capped, forms from other sites are refused, and the pages carry a strict Content-Security-Policy.
- **A weakness to know:** every instance receives the shared `GOOGLE_CLIENT_SECRET` (so it can refresh its tokens). Instances run on your server, not the customer's, but a serious vulnerability in one instance would expose that secret. The alternative (the control app doing all token exchanges) is a larger redesign.

## What is not built or not verified
- **Not built:** a customer billing page (the Stripe portal call exists in the client, but there is no screen or link to it yet, so customers cancel through Stripe's emails/receipts or you do it in the dashboard); any email (receipts come from Stripe; there is no welcome or failure email); an admin screen (look at the SQLite file or the logs); **plan limits** (nothing caps the number of sites per customer yet); **backups of customer data** (a customer's SQLite file lives in their Coolify volume; back the server up, and do not promise backups you have not set up); free trials; refunds; automatic app updates (each instance deploys the branch when created; redeploying them all is manual); Bing OAuth for hosted instances (Bing's API-key option works).
- **Not verified:** every call to Stripe and Coolify against the real services (they are written from the documentation: Checkout Sessions, Coolify's `POST /applications/public`, `PATCH /applications/{uuid}` with `docker_compose_domains`, `POST /applications/{uuid}/envs`, `POST /deploy?uuid=`, start, stop and delete); that Coolify's proxy issues a certificate for each new `c-xxxxxxxx` address in time (**Let's Encrypt allows about 50 new certificates a week per registered domain**, which caps how fast customers can be added, a figure I recall rather than checked); the Docker image; and whether Coolify keeps `is_shown_once` values usable by the app (they are hidden in the UI, not removed).
- **Google verification is the biggest gate.** I could not confirm from Google's pages whether Search Console and GA4 read access count as sensitive scopes. Google's own text says sensitive scopes need app verification (a verified domain, a privacy policy, a demo video and a justification for each scope), and restricted scopes an annual security assessment. Until the app is verified, expect a warning screen for customers and, I believe, a cap on the number of users (unconfirmed). Plan for this before selling to the public: **you need a real domain and a privacy policy and terms.**
- **Money and law:** taxes (Stripe Tax is not enabled here), refunds, terms of service, privacy policy and data-protection duties for holding customers' Google data are yours to settle with the right advice. This is software, not legal or financial advice.
