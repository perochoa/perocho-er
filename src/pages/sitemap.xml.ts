import type { APIRoute } from "astro";
import { site } from "../site";

// The indexable pages. Pages with `noindex` (form results, 404) stay out; the request form only
// counts while it's on (intakeUrl). public/robots.txt points here.
const paths = ["/", ...(site.intakeUrl ? ["/request/"] : [])];

export const GET: APIRoute = ({ site: origin }) => {
	const urls = paths.map((path) => `\t<url><loc>${new URL(path, origin)}</loc></url>`).join("\n");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
		{ headers: { "Content-Type": "application/xml" } },
	);
};
