# Intake worker

A Cloudflare Worker behind the site's repair request form (`/request/`). It reads each tech's
Google Calendar to offer open times, and offers each request to every tech by email, with a
tentative hold on the calendar of every tech free at the picked time. The first tech to take it
gets it, and the customer is emailed at each step. Repairs are drop-off only: the picked time is
when the customer brings the device in. A time and a phone number are required; without JS, or
when there are no open times, the form points people to Messenger and email instead.

Messenger, email and Facebook Marketplace stay as they are. The form is one more way in.

## For the techs

- **You're only bookable inside your "Available" blocks.** Add an event whose title starts with
  `Available` (e.g. `Available`, `Available - shop`) for each stretch you can take repairs; a
  repeating event works. A 13:00-16:00 block offers 13:00, 14:00 and 15:00. All-day blocks don't
  count. Delete or shorten a block to stop offering that time.
- **Your other events still block times inside a block.** All-day events, events set to "Free"
  and invites you declined don't.
- **Every request is emailed to every tech**, each with their own link, and a copy without
  links goes to `repairs@perocho.com`. If you're free at the picked time it's also on your
  calendar as a yellow, tentative `Request: ...` event, with the details and your link in its
  description. Every request has the customer's phone number, so you can call them to talk
  through the price (the offer page has a tap-to-call link); replying to the email reaches them
  too.
- **Open your link to take it or decline it.** Opening it changes nothing; the buttons do.
  - **Take it:** the first tech to press it gets the request. Your hold turns into a green
    `Repair: ...` booking (or one is created if you didn't have a hold), everyone else's hold
    is deleted, and the customer and the other techs are emailed. Anyone who presses it after
    you sees that you took it. You can take a request when you're busy (and move what was
    there), but not one at the same time as a repair you've already taken.
  - **Decline:** takes only you out; your hold is deleted and the others can still take it. You
    can change your mind and take it while it's open. Once every tech has declined, the customer
    is told nobody can take it.
  - **Nobody takes it in time:** once the picked time starts it can't be taken, and within the
    hour it expires: any holds are deleted and the customer is told nobody could take it.
    Requests sent before a time was required have none; those expire after 7 days.
- **To cancel or move a booking**, change or delete the event and email the customer yourself.
- **The customer gets an email** when the request comes in, when a tech takes it, when every
  tech declines or it expires, and if it failed to go through.
- If the emails fail to send, the customer still lands on "sent" when a hold was made, so check
  the calendar too: the hold has everything the email would have, including your link.
- Times are offered between 2 hours and 31 days ahead, in 60-minute slots on the hour (`LEAD_HOURS`, `DAYS_AHEAD`, `SLOT_MINUTES` in
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
   Email and Email submission, on the account that has the `repairs@perocho.com` identity.
4. **Set the secrets and deploy once** from this folder:

   ```sh
   npm ci
   npx wrangler login
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT   # paste the JSON key
   npx wrangler secret put FASTMAIL_TOKEN
   npx wrangler secret put TECHS                    # see below
   npx wrangler d1 create perocho-intake            # put the database_id it prints in wrangler.jsonc
   npx wrangler d1 migrations apply DB --remote
   npx wrangler deploy
   ```

   `TECHS` lists the techs; emails list them in this order. The calendar ID is the Gmail
   address for a main calendar, or the "Calendar ID" from the calendar's settings. `email` is
   where their requests go, and defaults to the calendar ID. It's a secret so the addresses stay
   out of this public repo.

   ```json
   [{ "name": "Richard", "calendarId": "richard@gmail.com", "email": "richard@example.com" }]
   ```

5. **Turn the form on:** set `intakeUrl` in `src/site.ts` to the URL `wrangler deploy` printed
   (no trailing slash) and merge that change. Until then the site hides every link to the form.
6. **Let CI deploy.** Create a Cloudflare API token (My Profile → API Tokens → Create Token →
   the "Edit Cloudflare Workers" template, plus Account → D1 → Edit for the migrations),
   limited to the one account and its zones. Add it in
   GitHub → the repo's Settings → Secrets and variables → Actions as `CLOUDFLARE_API_TOKEN`.
   Wrangler finds the account from the token, so no account ID is needed while the token covers
   only one account.

## Deploys

Merging to `main` deploys the worker from CI when anything under `worker/` changed
(`.github/workflows/deploy.yml`), applying any new `migrations/` to the database first. Running the workflow by hand (Actions > Deploy to GitHub Pages >
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
npm test        # slot logic, form parsing, and the handler with Google and Fastmail faked and
                # D1 on an in-memory SQLite with the real migrations
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

`npx wrangler dev` uses a local database; create its tables with
`npx wrangler d1 migrations apply DB --local`. Schema changes are new numbered files in
`migrations/`; never edit one that's been applied.

Changing who's a tech is `npx wrangler secret put TECHS` again; no deploy needed. Requests
already sent keep going to the techs they were sent to.

To check a TECHS list before or after setting it, put it in `techs.json` here (keep it out of
git) and the service account key in `.dev.vars` as `GOOGLE_SERVICE_ACCOUNT=...` on one line, or
pass `--key <file>`:

```sh
npm run check-techs             # the list, calendar sharing, "Available" blocks and open times
npm run check-techs -- --send   # also emails each tech a test (FASTMAIL_TOKEN in .dev.vars)
```

It changes nothing on the calendars, and exits 1 if any check failed.

## Spam

Two defences, neither needing JS:

- **Honeypot.** A hidden `website` field people never see. A post that fills it gets the "sent"
  page and nothing else happens.
- **Rate limit.** Each visitor IP (`CF-Connecting-IP`) gets **3 valid posts a minute**; past that
  they land on the "didn't go through" page and nothing is held or emailed, not even to the
  address they gave, so the form can't be used to flood someone's inbox. Honeypot and invalid
  posts don't count, since they cost nothing. Three covers a first try plus a couple of retries
  after "that time was just taken"; a real person doesn't send more than that in a minute.

  Change it in `ratelimits` in `wrangler.jsonc` (`limit`, and `period` of 10 or 60 seconds), then
  `npm run types` and deploy. Cloudflare counts per location and only roughly, so a bot spread
  over many IPs or locations can still get through; add Turnstile if that starts happening.
  Over-limit posts show up in the worker's logs as `rate limited a request`.

  `GET /slots` has its own limit, **20 fetches a minute** per IP (`SLOTS_LIMITER`), since each one
  reads every tech's calendar. Past it the worker answers 429, and the form says it couldn't
  load the times and points people to Messenger and email. These show up as `rate limited /slots`.
