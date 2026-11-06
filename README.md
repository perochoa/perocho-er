# perocho-er

The website for Perocho Repairs, PS5 repairs and upgrades in Mississauga, live at
<https://repairs.perocho.com>. A static [Astro](https://astro.build) site with no UI framework.

## Development

Needs Node 24 or later (`engines` in `package.json`).

```sh
npm ci
npm run dev      # local dev server on http://localhost:4321
npm run build    # static build into dist/
npm run preview  # serve the built dist/
npm run check    # typecheck (astro check)
```

### Running the request form locally

The form needs the intake worker running beside the dev server.

1. Put the worker's secrets in `worker/.dev.vars` (gitignored), each on one line, and let the dev
   server read `/slots`, which otherwise only `SITE_URL` may:

   ```sh
   DEV_ORIGINS=http://localhost:4321
   TECHS=[{"name":"...","calendarId":"...","email":"..."}]
   GOOGLE_SERVICE_ACCOUNT={"client_email":"...","private_key":"..."}
   FASTMAIL_TOKEN=
   ```

2. Start the worker on <http://localhost:8787>, with a local database:

   ```sh
   cd worker
   npm ci
   npx wrangler d1 migrations apply DB --local
   npx wrangler dev
   ```

3. Point `intakeUrl` in `src/site.ts` at `http://localhost:8787` (don't commit that) and run
   `npm run dev`.

The calendars are real: a request puts holds on the calendars in `TECHS`, so list only your own.
With `FASTMAIL_TOKEN` empty no email goes out; the request still goes through and the worker logs
the failed send. After a post the worker redirects to `SITE_URL`, the live site; add
`SITE_URL=http://localhost:4321` to `.dev.vars` to come back to the dev server.

## Content

- `src/site.ts`: name, contact links and other site-wide details. `intakeUrl` points at the
  intake worker; unset it to hide the request form and every link to it.
- `src/content/services/*.md`: one file per service, with its price.
- `src/content/repairs/<yyyy-mm-slug>/index.md`: past repairs, with before/after photos beside
  them. The repo is public, so strip location data from photos before committing.

Search engines and AI assistants read the same details: `src/structured-data.ts` builds the home
page's JSON-LD and `src/pages/llms.txt.ts` serves `/llms.txt`, both from `src/site.ts` and the
services. `public/robots.txt` lets every crawler in, AI ones by name.

## Deploy

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`, built with
`withastro/action`). `public/CNAME` sets the custom domain. Pull requests run
`.github/workflows/ci.yml`, which builds the site and typechecks and tests the intake worker.

Feature branches are made from `main` and tested on the branch itself. Once tested, each one
is squash-merged into `main` through a pull request, which deploys.

## Intake worker

The repair request form (`/request/`) posts to a Cloudflare Worker in `worker/`, a separate npm
package. See [`worker/README.md`](worker/README.md).
