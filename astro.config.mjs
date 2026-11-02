// @ts-check

import { defineConfig } from "astro/config";
import { site } from "./src/site";

// The request form fetches open times from the intake worker and posts to it.
const intake = site.intakeUrl ? new URL(site.intakeUrl).origin : "";

// https://astro.build/config
export default defineConfig({
	site: "https://repairs.perocho.com",
	// Shiki highlights code with inline styles, which the CSP below blocks. The content has no code.
	markdown: { syntaxHighlight: false },
	security: {
		// GitHub Pages can't send headers, so Astro puts the policy in a <meta> on every page, with
		// hashes of the scripts and styles it bundles. A <meta> policy can't set frame-ancestors,
		// report-uri or sandbox.
		csp: {
			directives: [
				"default-src 'self'",
				`connect-src 'self' ${intake}`,
				`form-action 'self' ${intake}`,
				"base-uri 'self'",
				"object-src 'none'",
			],
			styleDirective: {
				resources: [
					// Lists set a --i custom property in style="" to stagger their animations, and the
					// review bars set --share. Hashes can't cover style attributes, and they only ever
					// carry those values.
					{ resource: "'unsafe-inline'", kind: "attribute" },
				],
			},
		},
	},
});
