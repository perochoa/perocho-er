import type { APIRoute } from "astro";
import { getRepairs } from "../repairs";
import { site } from "../site";

// The indexable pages. Pages with `noindex` (form results, 404) stay out; the request form only
// counts while it's on (intakeUrl), and past repairs once there are any. public/robots.txt points here.
export const GET: APIRoute = async ({ site: origin }) => {
	const hasRepairs = (await getRepairs()).length > 0;
	const paths = ["/", ...(hasRepairs ? ["/repairs/"] : []), ...(site.intakeUrl ? ["/request/"] : [])];
	const urls = paths.map((path) => `\t<url><loc>${new URL(path, origin)}</loc></url>`).join("\n");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
		{ headers: { "Content-Type": "application/xml" } },
	);
};
