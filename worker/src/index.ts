// Intake for repairs.perocho.com.
//   GET  /slots    open times across the techs' calendars, for the form's time list
//   POST /request  the form; holds the picked time on a free tech's calendar and emails the techs,
//                  then redirects back to the site (the form works without JS)

import { sendMail } from "./fastmail.ts";
import { accessToken, createHold, listEvents } from "./google.ts";
import { describe, formatTime, parseIntake, replyTo, subject } from "./intake.ts";
import { openSlots, parseWorkHours } from "./slots.ts";

// Env comes from worker-configuration.d.ts (`npm run types` after changing wrangler.jsonc).

interface Tech {
	name: string;
	calendarId: string;
}

async function findSlots(env: Env, token: string) {
	const techs: Tech[] = JSON.parse(env.TECHS);
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
		{ slots: slots.map(({ start, end }) => ({ start: new Date(start), end: new Date(end) })) },
		{
			headers: {
				"Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : env.SITE_URL,
				"Cache-Control": "max-age=60",
				Vary: "Origin",
			},
		},
	);
}

async function request(env: Env, form: FormData): Promise<string> {
	const parsed = parseIntake(form);
	if (!parsed.ok) return parsed.spam ? "sent" : "failed";
	const { intake } = parsed;

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
		await createHold(token, tech.calendarId, {
			summary: `Request: ${intake.service || intake.device} (${intake.name})`,
			description: `${describe(intake, time, tech.name)}\n\nConfirm by renaming this event; delete it to free the time.`,
			start: slot.start,
			end: slot.end,
			timeZone: env.TIME_ZONE,
		});
	}

	await sendMail(env.FASTMAIL_TOKEN, {
		from: env.MAIL_FROM,
		to: env.MAIL_TO,
		replyTo: replyTo(intake),
		subject: subject(intake, time),
		text: describe(intake, time, tech?.name ?? null),
	});
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
				const outcome = await request(env, await req.formData());
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
