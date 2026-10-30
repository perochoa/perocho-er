// Intake for repairs.perocho.com.
//   GET  /slots          open drop-off times in the techs' "Available" blocks, for the form's time list
//   POST /request        the form; holds the picked time on every free tech's calendar, offers it to
//                        every tech by email and tells the customer, then redirects back to the
//                        site (the form works without JS)
//   GET  /offers/<token> one tech's link to a request: shows it, with buttons to take or decline it
//   POST /offers/<token> those buttons
//   GET  /offers/<token>/queue  that tech's queue: the repairs they took and haven't marked done
// and hourly (the cron in wrangler.jsonc) expires the requests nobody took in time.

import { sendMail } from "./fastmail.ts";
import { accessToken, createEvent, deleteEvent, listEvents } from "./google.ts";
import { formatTime, type Intake, parseIntake } from "./intake.ts";
import * as notices from "./notices.ts";
import { act, expire, page, queue } from "./offers.ts";
import { openSlots, type Slot, slotOptions } from "./slots.ts";
import { parseTechs, type Tech } from "./techs.ts";

// Env comes from worker-configuration.d.ts (`npm run types` after changing wrangler.jsonc).

async function findSlots(env: Env, token: string, techs = parseTechs(env.TECHS)) {
	const options = slotOptions(env, Date.now());
	const to = options.now + options.daysAhead * 86_400_000;
	// A calendar that can't be read (unshared, or a wrong calendarId in TECHS) costs that tech their
	// times, not everyone's. The log names the tech; only when no calendar can be read is it an error.
	const results = await Promise.allSettled(
		techs.map((tech) => listEvents(token, tech.calendarId, options.now, to)),
	);
	const events = results.map((result, i) => {
		if (result.status === "fulfilled") return result.value;
		console.error(`can't read ${techs[i].name}'s calendar; check their calendarId in TECHS and that it's shared`, result.reason);
		return [];
	});
	if (results.every((result) => result.status === "rejected")) throw new Error("no tech's calendar could be read");
	return { techs, slots: openSlots(events, options) };
}

async function slots(env: Env, origin: string | null, ip: string | null): Promise<Response> {
	// Each fetch costs a Google call per tech, so cap it per visitor. The form treats any non-OK
	// response as no times to pick, and points people to Messenger and email instead.
	const { success } = await env.SLOTS_LIMITER.limit({ key: ip ?? "unknown" });
	if (!success) {
		console.warn("rate limited /slots");
		return new Response("Too many requests", { status: 429 });
	}
	const allowed = [env.SITE_URL, ...env.DEV_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)];
	const { slots: open } = await findSlots(env, await accessToken(env.GOOGLE_SERVICE_ACCOUNT));
	return Response.json(
		{
			timeZone: env.TIME_ZONE,
			slots: open.map(({ start, end }) => ({ start: new Date(start), end: new Date(end) })),
		},
		{
			headers: {
				"Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : env.SITE_URL,
				// Revalidate every time: after a "closed" result the form must not re-offer the time
				// it just turned down from the browser's cache.
				"Cache-Control": "no-cache",
				Vary: "Origin",
			},
		},
	);
}

// Each outcome is a page in src/pages/request/[outcome].astro, so add or remove them together.
// "closed": the picked time isn't open any more (now inside the lead time, or a tech changed their
// blocks or added an event); other requests never close a time, since drop-offs share them.
type Outcome = "sent" | "closed" | "failed";

async function request(env: Env, form: FormData, ip: string | null, origin: string): Promise<Outcome> {
	const parsed = parseIntake(form, env.RUSH_FEE);
	if (!parsed.ok) return parsed.spam ? "sent" : "failed";
	const { intake } = parsed;

	// Only a valid post costs Google and Fastmail calls, so only those count; honeypot bots keep
	// seeing "sent". Without the header (local dev) every visitor shares one count. Nobody is
	// emailed past the limit, or the form could be used to flood someone's inbox.
	const { success } = await env.REQUEST_LIMITER.limit({ key: ip ?? "unknown" });
	if (!success) {
		console.warn("rate limited a request");
		return "failed";
	}

	try {
		return await file(env, intake, origin);
	} catch (error) {
		console.error(error);
		try {
			await sendMail(env.FASTMAIL_TOKEN, [{ from: env.MAIL_FROM, ...notices.failed(intake) }]);
		} catch (error) {
			console.error(error);
		}
		return "failed";
	}
}

interface Offer {
	token: string;
	tech: Tech;
	holdId: string | null;
}

// A tentative hold on the tech's calendar. It's "free", so it never keeps anyone else from the time.
const hold = (env: Env, token: string, offer: Offer, slot: Slot, intake: Intake, link: string) =>
	createEvent(token, offer.tech.calendarId, {
		summary: notices.holdSummary(intake),
		description: notices.holdDescription(intake, formatTime(slot.start, env.TIME_ZONE), link),
		start: slot.start,
		end: slot.end,
		timeZone: env.TIME_ZONE,
	});

// How long the same form sent again counts as the request already filed.
const REPEAT_MS = 10 * 60_000;

async function file(env: Env, intake: Intake, origin: string): Promise<Outcome> {
	// A double press, or the form sent again from the back button, is the request already filed:
	// filing it again would email everyone twice.
	const repeat = await env.DB.prepare("SELECT 1 FROM requests WHERE intake = ? AND created > ?")
		.bind(JSON.stringify(intake), Date.now() - REPEAT_MS)
		.first();
	if (repeat) return "sent";

	const techs = parseTechs(env.TECHS);
	const offers: Offer[] = techs.map((tech) => ({ token: crypto.randomUUID(), tech, holdId: null }));
	const link = (offer: Offer) => `${origin}/offers/${offer.token}`;

	const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
	const slot = (await findSlots(env, token, techs)).slots.find((s) => s.start === intake.slot);
	if (!slot) return "closed";

	// Every tech free then gets a hold, so they can all plan around it until one takes it.
	const held = await Promise.allSettled(
		slot.techs.map((i) => hold(env, token, offers[i], slot, intake, link(offers[i]))),
	);
	held.forEach((result, i) => {
		if (result.status === "fulfilled") offers[slot.techs[i]].holdId = result.value;
		else console.error(result.reason);
	});
	// An open time has a free tech, so no holds at all means Google failed.
	if (!offers.some((offer) => offer.holdId)) {
		throw (held.find((result) => result.status === "rejected") as PromiseRejectedResult).reason;
	}

	const id = crypto.randomUUID();
	const db = env.DB;
	const rows = [
		db.prepare("INSERT INTO requests (id, created, intake, slot_start, slot_end, rush) VALUES (?, ?, ?, ?, ?, ?)")
			.bind(id, Date.now(), JSON.stringify(intake), slot.start, slot.end, intake.rush),
		...offers.map((offer, position) =>
			db.prepare(
				"INSERT INTO offers (token, request_id, position, name, email, calendar_id, hold_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind(offer.token, id, position, offer.tech.name, offer.tech.email, offer.tech.calendarId, offer.holdId),
		),
	];
	const holds = offers.filter((offer) => offer.holdId);
	try {
		await db.batch(rows);
	} catch (error) {
		// Without the rows the links lead nowhere, so let the holds go too.
		await Promise.allSettled(holds.map((offer) => deleteEvent(token, offer.tech.calendarId, offer.holdId!)));
		throw error;
	}

	const time = formatTime(slot.start, env.TIME_ZONE);
	const offered = offers.map((offer) => ({
		name: offer.tech.name,
		email: offer.tech.email,
		link: link(offer),
		held: offer.holdId !== null,
	}));
	try {
		await sendMail(
			env.FASTMAIL_TOKEN,
			[
				...offered.map((tech) => notices.toTech(intake, time, tech)),
				notices.record(intake, time, env.MAIL_TO, offered),
				notices.received(intake, time),
			].map((mail) => ({ from: env.MAIL_FROM, ...mail })),
		);
	} catch (error) {
		// There's always a hold by now, and its description has every detail and the tech's link.
		// Sending them to "failed" would make a retry file it twice, and any emails that did go out
		// need their links to keep working.
		console.error(error);
	}
	return "sent";
}

const OFFER = /^\/offers\/([0-9a-f-]{36})$/;
const QUEUE = /^\/offers\/([0-9a-f-]{36})\/queue$/;

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(req.url);
		try {
			if (req.method === "GET" && pathname === "/slots") {
				return await slots(env, req.headers.get("Origin"), req.headers.get("CF-Connecting-IP"));
			}
			if (req.method === "POST" && pathname === "/request") {
				const ip = req.headers.get("CF-Connecting-IP");
				const outcome = await request(env, await req.formData(), ip, new URL(req.url).origin);
				return Response.redirect(`${env.SITE_URL}/request/${outcome}/`, 303);
			}
			const offer = pathname.match(OFFER);
			if (offer && req.method === "GET") return await page(env, offer[1]);
			const mine = pathname.match(QUEUE);
			if (mine && req.method === "GET") return await queue(env, mine[1]);
			if (offer && req.method === "POST") {
				// A body that isn't a form is a press of no button.
				const form = await req.formData().catch(() => null);
				await act(env, offer[1], String(form?.get("action") ?? ""));
				// Back to the page, which now shows where the request stands.
				return Response.redirect(req.url, 303);
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error(error);
			if (pathname === "/request") return Response.redirect(`${env.SITE_URL}/request/failed/`, 303);
			if (OFFER.test(pathname)) {
				return new Response("Something went wrong, so nothing changed. Go back and try again.", { status: 500 });
			}
			return new Response("Something went wrong", { status: 500 });
		}
	},

	async scheduled(_controller, env): Promise<void> {
		await expire(env);
	},
} satisfies ExportedHandler<Env>;
