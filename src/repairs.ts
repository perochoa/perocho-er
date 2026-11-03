// The repairs collection, newest first, as the home page, /repairs/, the sitemap and llms.txt list it.
import { getCollection } from "astro:content";

export const getRepairs = async () =>
	(await getCollection("repairs")).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

// "October 2026". Dates are midnight UTC, so they're shown in UTC: a build west of it would show the
// 1st as the month before.
export const monthFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", month: "long", year: "numeric" });
