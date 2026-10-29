# Intake worker

A Cloudflare Worker behind the site's repair request form (`/request/`). It reads each tech's
Google Calendar to offer open times, holds the picked time as a tentative event on a free tech's
calendar, and emails the request to `contact@perocho.com` with the customer as Reply-To. People
without JS can still send the form; they just don't get the time list.

Messenger, email and Facebook Marketplace stay as they are. The form is one more way in.

## For the techs

- **You're bookable 9:00 to 17:00 every day, weekends included,** wherever your calendar has
  no event (`WORK_HOURS` in `wrangler.jsonc`). Keep your calendar up to date, and add an event
  for any time off.
- **Your events block times automatically.** All-day events, events set to "Free" and invites
  you declined don't.
- **A request shows up as a yellow, tentative `Request: ...` event** with the details in its
  description, and an email arrives at `contact@perocho.com`. Reply to the email to reach the
  customer. If the email fails to send, the customer is still told the request went through,
  so check the calendar too: the event has everything the email would have.
  - Confirm it: rename the event (e.g. `Booked: ...`). It keeps the time blocked.
  - Decline or move it: delete the event (that frees the time), then contact the customer.
- Times are offered between 12 hours and 14 days ahead, in 60-minute slots on the hour (`LEAD_HOURS`, `DAYS_AHEAD`, `SLOT_MINUTES` in
  `wrangler.jsonc`).

## Setup

All free tiers. Do these once.

1. **Google service account.** In [Google Cloud console](https://console.cloud.google.com/),
   create a project, enable the Google Calendar API, create a service account and download a
   JSON key for it.
2. **Share each tech's calendar** (Google Calendar → Settings → the calendar → Share with
   specific people) with the service account's email, permission **Make changes to events**.
   The worker can then see every event on that calendar. A tech who'd rather not share their
   main calendar can make a separate "Repairs" calendar and share that instead, but then their
   personal events won't block times.
3. **Fastmail API token.** Fastmail → Settings → Privacy & Security → API tokens, with access to
   Email and Email submission, on the account that has the `contact@perocho.com` identity.
4. **Set the secrets and deploy once** from this folder:

   ```sh
   npm ci
   npx wrangler login
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT   # paste the JSON key
   npx wrangler secret put FASTMAIL_TOKEN
   npx wrangler secret put TECHS                    # see below
   npx wrangler deploy
   ```

   `TECHS` lists the techs in the order they get requests when more than one is free. The
   calendar ID is the Gmail address for a main calendar, or the "Calendar ID" from the
   calendar's settings. It's a secret so the addresses stay out of this public repo.

   ```json
   [{ "name": "Richard", "calendarId": "richard@gmail.com" }]
   ```

5. **Turn the form on:** set `intakeUrl` in `src/site.ts` to the URL `wrangler deploy` printed
   (no trailing slash) and merge that change. Until then the site hides every link to the form.
6. **Let CI deploy.** Create a Cloudflare API token (My Profile → API Tokens → Create Token →
   the "Edit Cloudflare Workers" template), limited to the one account and its zones. Add it in
   GitHub → the repo's Settings → Secrets and variables → Actions as `CLOUDFLARE_API_TOKEN`.
   Wrangler finds the account from the token, so no account ID is needed while the token covers
   only one account.

## Deploys

Merging to `main` deploys the worker from CI when anything under `worker/` changed
(`.github/workflows/deploy.yml`). Running the workflow by hand (Actions > Deploy to GitHub Pages >
Run workflow) always deploys the worker, then the site. The job runs the types check, typecheck
and tests first, and the site deploys only after it, so a site change that needs a new worker
response never goes out first. When nothing under `worker/` changed, the worker job is skipped
and the site deploys on its own. If the worker job fails, the site doesn't deploy either.

`npx wrangler deploy` from this folder still works for a hotfix; the next merge that touches
`worker/` deploys `main` over it, so merge the fix too. Secrets aren't part of a deploy: set
them with `npx wrangler secret put`, and add new ones to `secrets.required` (deploy fails until
they're set).

## Development

```sh
npm test        # slot logic, form parsing, and the handler with Google and Fastmail faked
npm run check   # typecheck the worker (no Node types) and the tests (tsconfig.test.json)
npm run types   # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

`Env` comes from `worker-configuration.d.ts`, generated from `vars` and `secrets.required` in
`wrangler.jsonc`. Commit it; CI fails if it's out of date. Add a new secret to
`secrets.required` as well: that types it, and deploy fails until it's set.

Only `SITE_URL` may read `/slots` from a browser. To try the form from `npm run dev` on the site
with `npx wrangler dev`, allow the dev server in a `worker/.dev.vars` file (gitignored), along
with the secrets:

```sh
DEV_ORIGINS=http://localhost:4321
```

Changing who's a tech is `npx wrangler secret put TECHS` again; no deploy needed.

## Spam

Two defences, neither needing JS:

- **Honeypot.** A hidden `website` field people never see. A post that fills it gets the "sent"
  page and nothing else happens.
- **Rate limit.** Each visitor IP (`CF-Connecting-IP`) gets **3 valid posts a minute**; past that
  they land on the "didn't go through" page and nothing is held or emailed. Honeypot and invalid
  posts don't count, since they cost nothing. Three covers a first try plus a couple of retries
  after "that time was just taken"; a real person doesn't send more than that in a minute.

  Change it in `ratelimits` in `wrangler.jsonc` (`limit`, and `period` of 10 or 60 seconds), then
  `npm run types` and deploy. Cloudflare counts per location and only roughly, so a bot spread
  over many IPs or locations can still get through; add Turnstile if that starts happening.
  Over-limit posts show up in the worker's logs as `rate limited a request`.
