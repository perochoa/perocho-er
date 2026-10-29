import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const services = defineCollection({
	loader: glob({ pattern: "*.md", base: "./src/content/services" }),
	schema: z.object({
		title: z.string(),
		order: z.number(),
		// Free text, not a number: prices carry bundles and per-unit deals ("$70, or $100 with...").
		// Leave it unset to show "Message us for a quote".
		price: z.string().optional(),
	}),
});

// One folder per repair: src/content/repairs/yyyy-mm-<slug>/index.md, with its photos beside it.
// Strip location data from photos before committing them: the repo is public.
const repairs = defineCollection({
	loader: glob({ pattern: "*/index.md", base: "./src/content/repairs" }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			device: z.string(),
			date: z.coerce.date(),
			before: image(),
			beforeAlt: z.string(),
			after: image(),
			afterAlt: z.string(),
		}),
});

export const collections = { services, repairs };
