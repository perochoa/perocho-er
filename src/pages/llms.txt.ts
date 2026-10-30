import type { APIRoute } from "astro";
import { marketplace } from "../reviews";
import { getServices, priceText } from "../services";
import { site } from "../site";

// The site as Markdown for AI assistants (https://llmstxt.org), from the same details the home page
// shows. public/robots.txt lets their crawlers in.
export const GET: APIRoute = async ({ site: origin }) => {
	const link = (path: string) => new URL(path, origin).href;
	const services = await getServices();
	const lines = [
		`# ${site.name}`,
		"",
		`> ${site.description}`,
		"",
		`${site.tagline} ${site.intro}`,
		"",
		"## Services and prices",
		"",
		...services.flatMap(({ data, body }) => [
			`### ${data.title}`,
			"",
			`Price: ${priceText(data)} (Canadian dollars).`,
			"",
			(body ?? "").trim(),
			"",
		]),
		"## How to get a repair",
		"",
		...(site.intakeUrl
			? [
					`- [Request a repair](${link("/request/")}) and pick a drop-off time online. A tech confirms by email.`,
					`- Need it sooner? A rush moves it to the front of the line for $${site.rushFee}.`,
				]
			: ["- Message us on Messenger or by email for a quote and a drop-off time."]),
		...(site.serviceArea ? [`- Where: ${site.serviceArea}`] : []),
		...(site.hours ? [`- When: ${site.hours}`] : []),
		"- Payment: cash or Interac e-Transfer at pickup.",
		"",
		"## Contact",
		"",
		`- Email: ${site.email}`,
		`- Messenger: ${site.messengerUrl}`,
		...(marketplace
			? [
					`- Facebook Marketplace: ${marketplace.url} (${marketplace.stars} stars from ${marketplace.ratings} ratings)`,
				]
			: []),
		"",
		"## Pages",
		"",
		`- [Home](${link("/")}): services, prices, reviews and contact details`,
		...(site.intakeUrl ? [`- [Request a repair](${link("/request/")}): the repair request form`] : []),
		"",
	];
	return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
