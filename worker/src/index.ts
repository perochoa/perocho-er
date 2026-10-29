// Intake for repairs.perocho.com.
//   GET  /slots    open times across the techs' calendars, for the form's time list
//   POST /request  the form; holds the picked time on a free tech's calendar and emails the techs,
//                  then redirects back to the site (the form works without JS)

import { sendMail } from "./fastmail.ts";
import { accessToken, createHold, deleteEvent, listEvents, type ListedEvent } from "./google.ts";
import { describe, formatTime, parseIntake, replyTo, subject, what } from "./intake.ts";
import { blocks, openSlots, parseWorkHours } from "./slots.ts";

// Env comes from worker-configuration.d.ts (`npm run types` after changing wrangler.jsonc).

interface Tech {
	name: string;
	calendarId: string;
}

// The secret is a JSON list of techs. Errors name TECHS but never echo it.
function parseTechs(raw: string): Tech[] {
	let techs: unknown;
	try {
		techs = JSON.parse(raw);
	} catch {
		throw new Error("TECHS is not valid JSON");
	}
	const valid =
		Array.isArray(techs) &&
		techs.length > 0 &&
		techs.every((tech) => typeof tech?.name === "string" && typeof tech?.calendarId === "string");
	if (!valid) throw new Error("TECHS must be a non-empty array of { name, calendarId } strings");
	return techs as Tech[];
}

async function findSlots(env: Env, token: string) {
	const techs = parseTechs(env.TECHS);
	const options = {
		now: Date.now(),
		slotMinutes: env.SLOT_MINUTES,
		leadHours: env.LEAD_HOURS,
		daysAhead: env.DAYS_AHEAD,
		workHours: parseWorkHours(env.WORK_HOURS),
		timeZone: env.TIME_ZONE,
	};
	const to = options.now + options.daysAhead * 86_400_000;
	const events = await Promise.all(
		techs.map((tech) => listEvents(token, tech.calendarId, options.now, to)),
	);
	return { techs, slots: openSlots(events, options) };
}

async function slots(env: Env, origin: string | null): Promise<Response> {
	const allowed = [env.SITE_URL, ...env.DEV_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)];
	const { slots } = await findSlots(env, await accessToken(env.GOOGLE_SERVICE_ACCOUNT));
	return Response.json(
		{
			timeZone: env.TIME_ZONE,
			slots: slots.map(({ start, end }) => ({ start: new Date(start), end: new Date(end) })),
		},
		{
			headers: {
				"Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : env.SITE_URL,
				"Cache-Control": "max-age=60",
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

async function request(env: Env, form: FormData, ip: string | null): Promise<Outcome> {
	const parsed = parseIntake(form);
	if (!parsed.ok) return parsed.spam ? "sent" : "failed";
	const { intake } = parsed;

	// Only a valid post costs Google and Fastmail calls, so only those count; honeypot bots keep
	// seeing "sent". Without the header (local dev) every visitor shares one count.
	const { success } = await env.REQUEST_LIMITER.limit({ key: ip ?? "unknown" });
	if (!success) {
		console.warn("rate limited a request");
		return "failed";
	}

	let time: string | null = null;
	let tech: Tech | null = null;
	if (intake.slot !== null) {
		const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
		const found = await findSlots(env, token);
		const slot = found.slots.find((s) => s.start === intake.slot);
		if (!slot) return "taken";

		// First free tech in the TECHS order takes it; the techs can swap it between them.
		tech = found.techs[slot.techs[0]];
		time = formatTime(slot.start, env.TIME_ZONE);
		const hold = await createHold(token, tech.calendarId, {
			summary: `Request: ${what(intake)} (${intake.name})`,
			description: `${describe(intake, time, tech.name)}\n\nConfirm by renaming this event; delete it to free the time.`,
			start: slot.start,
			end: slot.end,
			timeZone: env.TIME_ZONE,
		});

		// Two requests for one slot can both get past the check above and both write a hold, so look
		// again now that ours is written: if anything else blocking the slot came first, give it up.
		// That covers any event, not only other requests' holds, so it doesn't rely on their titles.
		// Losing means "taken" rather than trying the next free tech: it's rare, and they pick again
		// from a fresh list.
		try {
			const events = await listEvents(token, tech.calendarId, slot.start, slot.end);
			const lost = events.some(
				(event) =>
					event.id !== hold.id &&
					blocks(event) &&
					event.start < slot.end &&
					event.end > slot.start &&
					before(event, hold),
			);
			if (lost) {
				await deleteEvent(token, tech.calendarId, hold.id);
				return "taken";
			}
		} catch (error) {
			// Our hold is written, so carry on and send the email; at worst the techs see two holds.
			console.error(error);
		}
	}

	try {
		await sendMail(env.FASTMAIL_TOKEN, {
			from: env.MAIL_FROM,
			to: env.MAIL_TO,
			replyTo: replyTo(intake),
			subject: subject(intake, time),
			text: describe(intake, time, tech?.name ?? null),
		});
	} catch (error) {
		// Without a hold the email is the only copy of the request, so it failed. With one, the
		// hold's description already has every detail, and sending them to "failed" would make a
		// retry find their own hold and say "taken".
		if (!tech) throw error;
		console.error(error);
	}
	return "sent";
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(req.url);
		try {
			if (req.method === "GET" && pathname === "/slots") {
				return await slots(env, req.headers.get("Origin"));
			}
			if (req.method === "POST" && pathname === "/request") {
				const outcome = await request(env, await req.formData(), req.headers.get("CF-Connecting-IP"));
				return Response.redirect(`${env.SITE_URL}/request/${outcome}/`, 303);
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			console.error(error);
			if (pathname === "/request") return Response.redirect(`${env.SITE_URL}/request/failed/`, 303);
			return new Response("Something went wrong", { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
