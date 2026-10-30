# perocho-er

The website for Perocho Repairs, PS5 repairs and upgrades in Mississauga, live at
https://repairs.perocho.com. A static [Astro](https://astro.build) site with no UI framework.

## Development

Needs Node 24 or later (`engines` in `package.json`).

```sh
npm ci
npm run dev      # local dev server
npm run build    # static build into dist/
npm run preview  # serve the built dist/
npm run check    # typecheck (astro check)
```

## Content

- `src/site.ts`: name, contact links and other site-wide details. `intakeUrl` points at the
  intake worker; unset it to hide the request form and every link to it.
- `src/content/services/*.md`: one file per service, with its price.
- `src/content/repairs/<yyyy-mm-slug>/index.md`: past repairs, with before/after photos beside
  them. The repo is public, so strip location data from photos before committing.

## Deploy

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`, built with
`withastro/action`). `public/CNAME` sets the custom domain. Pull requests run
`.github/workflows/ci.yml`, which builds the site and typechecks and tests the intake worker.

Feature branches are made from `dev` and opened as pull requests into `dev` for testing. Once
tested, `dev` is merged into `main`, which deploys.

## Intake worker

The repair request form (`/request/`) posts to a Cloudflare Worker in `worker/`, a separate npm
package. See [`worker/README.md`](worker/README.md).
