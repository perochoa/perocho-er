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
  customer.
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
4. **Deploy** from this folder:

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

## Development

```sh
npm test        # slot logic, form parsing, and the handler with Google and Fastmail faked
npm run check   # typecheck
```

Changing who's a tech is `npx wrangler secret put TECHS` again; no deploy needed.
