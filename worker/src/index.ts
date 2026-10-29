// Intake for repairs.perocho.com.
//   GET  /slots          open times in the techs' "Available" blocks, for the form's time list
//   POST /request        the form; holds the picked time on every free tech's calendar, offers it to
//                        every tech by email and tells the customer, then redirects back to the
//                        site (the form works without JS)
//   GET  /offers/<token> one tech's link to a request: shows it, with buttons to take or decline it
//   POST /offers/<token> those buttons

import { sendMail } from "./fastmail.ts";
import { accessToken, createEvent, deleteEvent, listEvents, type ListedEvent } from "./google.ts";
import { formatTime, type Intake, parseIntake } from "./intake.ts";
import * as notices from "./notices.ts";
import { act, page } from "./offers.ts";
import { blocks, openSlots, type Slot } from "./slots.ts";

// Env comes from worker-configuration.d.ts (`npm run types` after changing wrangler.jsonc).

export interface Tech {
	name: string;
	calendarId: string;
	email?: string; // where their requests go; defaults to calendarId
}

// The secret is a JSON list of techs. Errors name TECHS but never echo it.
export function parseTechs(raw: string): Tech[] {
	let techs: unknown;
	try {
		techs = JSON.parse(raw);
	} catch {
		throw new Error("TECHS is not valid JSON");
	}
	const valid =
		Array.isArray(techs) &&
		techs.length > 0 &&
		techs.every(
			(tech) =>
				typeof tech?.name === "string" &&
				typeof tech?.calendarId === "string" &&
				(tech.email === undefined || typeof tech.email === "string"),
		);
	if (!valid) throw new Error("TECHS must be a non-empty array of { name, calendarId, email? } strings");
	return techs as Tech[];
}

async function findSlots(env: Env, token: string, techs = parseTechs(env.TECHS)) {
	const options = {
		now: Date.now(),
		slotMinutes: env.SLOT_MINUTES,
		leadHours: env.LEAD_HOURS,
		daysAhead: env.DAYS_AHEAD,
	};
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
	// response as "no times online" and falls back to the notes.
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
				// Revalidate every time: after a "taken" result the form must not re-offer the slot it
				// just lost from the browser's cache.
				"Cache-Control": "no-cache",
				Vary: "Origin",
			},
		},
	);
}

// Whether `event` was written before our hold. Ties on `created` fall back to the id, so two
// racing requests always agree on which of them came first.
const before = (event: ListedEvent, hold: { id: string; created: number }) =>
	event.created < hold.created || (event.created === hold.created && event.id < hold.id);

// Each outcome is a page in src/pages/request/[outcome].astro, so add or remove them together.
type Outcome = "sent" | "taken" | "failed";

async function request(env: Env, form: FormData, ip: string | null, origin: string): Promise<Outcome> {
	const parsed = parseIntake(form);
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

// A tentative hold on the tech's calendar, or null when a racing request held the slot first.
async function hold(env: Env, token: string, offer: Offer, slot: Slot, intake: Intake, link: string) {
	const time = formatTime(slot.start, env.TIME_ZONE);
	const { calendarId } = offer.tech;
	const ours = await createEvent(token, calendarId, {
		summary: notices.holdSummary(intake),
		description: notices.holdDescription(intake, time, link),
		start: slot.start,
		end: slot.end,
		timeZone: env.TIME_ZONE,
	});

	// Two requests for one slot can both get past the first check and both write a hold, so look
	// again now that ours is written: if anything else blocking the slot came first, give it up.
	// That covers any event, not only other requests' holds, so it doesn't rely on their titles.
	try {
		const events = await listEvents(token, calendarId, slot.start, slot.end);
		const lost = events.some(
			(event) =>
				event.id !== ours.id &&
				blocks(event) &&
				event.start < slot.end &&
				event.end > slot.start &&
				before(event, ours),
		);
		if (lost) {
			await deleteEvent(token, calendarId, ours.id);
			return null;
		}
	} catch (error) {
		// Our hold is written, so keep it; at worst the tech sees two holds.
		console.error(error);
	}
	return ours.id;
}

async function file(env: Env, intake: Intake, origin: string): Promise<Outcome> {
	const techs = parseTechs(env.TECHS);
	const offers: Offer[] = techs.map((tech) => ({ token: crypto.randomUUID(), tech, holdId: null }));
	const link = (offer: Offer) => `${origin}/offers/${offer.token}`;

	let slot: Slot | null = null;
	let token: string | null = null;
	if (intake.slot !== null) {
		token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
		slot = (await findSlots(env, token, techs)).slots.find((s) => s.start === intake.slot) ?? null;
		if (!slot) return "taken";

		// Every tech free then gets a hold, so they can all plan around it until one takes it.
		const held = await Promise.allSettled(
			slot.techs.map((i) => hold(env, token!, offers[i], slot!, intake, link(offers[i]))),
		);
		held.forEach((result, i) => {
			if (result.status === "fulfilled") offers[slot!.techs[i]].holdId = result.value;
			else console.error(result.reason);
		});
		if (!offers.some((offer) => offer.holdId)) {
			// Lost every race means taken; anything else is a failure.
			const failure = held.find((result) => result.status === "rejected");
			if (failure) throw failure.reason;
			return "taken";
		}
	}

	const id = crypto.randomUUID();
	const db = env.DB;
	const rows = [
		db.prepare("INSERT INTO requests (id, created, intake, slot_start, slot_end) VALUES (?, ?, ?, ?, ?)")
			.bind(id, Date.now(), JSON.stringify(intake), slot?.start ?? null, slot?.end ?? null),
		...offers.map((offer, position) =>
			db.prepare(
				"INSERT INTO offers (token, request_id, position, name, email, calendar_id, hold_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind(offer.token, id, position, offer.tech.name, offer.tech.email ?? offer.tech.calendarId, offer.tech.calendarId, offer.holdId),
		),
	];
	const holds = offers.filter((offer) => offer.holdId);
	try {
		await db.batch(rows);
	} catch (error) {
		// Without the rows the links lead nowhere, so let the holds go too.
		await Promise.allSettled(holds.map((offer) => deleteEvent(token!, offer.tech.calendarId, offer.holdId!)));
		throw error;
	}

	const time = slot && formatTime(slot.start, env.TIME_ZONE);
	const offered = offers.map((offer) => ({
		name: offer.tech.name,
		email: offer.tech.email ?? offer.tech.calendarId,
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
		// Without a hold the emails were the only way the techs would hear of it. With one, its
		// description has every detail and the tech's link, and sending them to "failed" would
		// make a retry find their own hold and say "taken".
		if (holds.length === 0) {
			await db.batch([
				db.prepare("DELETE FROM offers WHERE request_id = ?").bind(id),
				db.prepare("DELETE FROM requests WHERE id = ?").bind(id),
			]);
			throw error;
		}
		console.error(error);
	}
	return "sent";
}

const OFFER = /^\/offers\/([0-9a-f-]{36})$/;

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
			if (offer && req.method === "POST") {
				await act(env, offer[1], String((await req.formData()).get("action") ?? ""));
				// Back to the page, which now shows where the request stands.
				return Response.redirect(req.url, 303);
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error(error);
			if (pathname === "/request") return Response.redirect(`${env.SITE_URL}/request/failed/`, 303);
			return new Response("Something went wrong", { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
