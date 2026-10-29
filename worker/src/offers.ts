// A request offered to each tech. Their link opens a page that shows the request and lets them
// take or decline it. The page only shows it; the buttons POST, because mail scanners open the
// links in emails and must not take requests by doing so.

import { type Mail, sendMail } from "./fastmail.ts";
import { accessToken, bookEvent, createEvent, deleteEvent } from "./google.ts";
import { describe, formatTime, type Intake, stop } from "./intake.ts";
import * as notices from "./notices.ts";

interface RequestRow {
	id: string;
	intake: string;
	slot_start: number | null;
	slot_end: number | null;
	status: "pending" | "confirmed" | "declined";
	confirmed_by: string | null;
}

interface OfferRow {
	token: string;
	request_id: string;
	name: string;
	email: string;
	calendar_id: string;
	hold_id: string | null;
	declined: number;
}

async function load(db: D1Database, token: string) {
	const offer = await db.prepare("SELECT * FROM offers WHERE token = ?").bind(token).first<OfferRow>();
	if (!offer) return null;
	const request = await db.prepare("SELECT * FROM requests WHERE id = ?").bind(offer.request_id).first<RequestRow>();
	if (!request) return null;
	const { results: offers } = await db
		.prepare("SELECT * FROM offers WHERE request_id = ? ORDER BY position")
		.bind(request.id)
		.all<OfferRow>();
	const intake: Intake = JSON.parse(request.intake);
	return { offer, request, offers, intake };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

const timeOf = (env: Env, request: RequestRow) =>
	request.slot_start === null ? null : formatTime(request.slot_start, env.TIME_ZONE);

const send = async (env: Env, mails: Omit<Mail, "from">[]) => {
	try {
		await sendMail(env.FASTMAIL_TOKEN, mails.map((mail) => ({ from: env.MAIL_FROM, ...mail })));
	} catch (error) {
		// The request is settled either way; the calendar and this page show where it stands.
		console.error(error);
	}
};

// Once the time has started nobody can take it; the scheduled job expires it.
const passed = (request: RequestRow, now = Date.now()) => request.slot_start !== null && request.slot_start <= now;

// First tech to get here takes it. A tech who declined can still change their mind while it's open.
async function confirm(env: Env, { offer, request, offers, intake }: Loaded) {
	const won = await env.DB.prepare(
		`UPDATE requests SET status = 'confirmed', confirmed_by = ?1
		 WHERE id = ?2 AND status = 'pending' AND (slot_start IS NULL OR slot_start > ?3)`,
	)
		.bind(offer.token, request.id, Date.now())
		.run();
	if (won.meta.changes !== 1) return;
	await env.DB.prepare("UPDATE offers SET declined = 0 WHERE token = ?").bind(offer.token).run();

	const time = timeOf(env, request);
	if (time !== null) {
		// Their hold becomes the booking, or they get a new one if they weren't free when it came
		// in, had declined, or deleted the hold. Everyone else's hold goes.
		try {
			const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
			const booking = {
				summary: notices.bookedSummary(intake),
				description: notices.bookedDescription(intake, time, offer.name),
			};
			const book = async () => {
				if (offer.hold_id && (await bookEvent(token, offer.calendar_id, offer.hold_id, booking))) return;
				await createEvent(
					token,
					offer.calendar_id,
					{ ...booking, start: request.slot_start!, end: request.slot_end!, timeZone: env.TIME_ZONE },
					true,
				);
			};
			const others = offers.filter((other) => other.token !== offer.token && other.hold_id);
			const results = await Promise.allSettled([
				book(),
				...others.map((other) => deleteEvent(token, other.calendar_id, other.hold_id!)),
			]);
			for (const result of results) if (result.status === "rejected") console.error(result.reason);
		} catch (error) {
			console.error(error);
		}
	}

	await send(env, [
		notices.confirmed(intake, time, offer.name),
		...offers
			.filter((other) => other.token !== offer.token && !other.declined)
			.map((other) => notices.taken(intake, time, other.email, offer.name)),
		notices.taken(intake, time, env.MAIL_TO, offer.name),
	]);
}

// Takes only this tech out. Once nobody's left, the customer hears it's a no.
async function decline(env: Env, { offer, request, intake }: Loaded) {
	if (request.status !== "pending") return;
	const changed = await env.DB.prepare("UPDATE offers SET declined = 1, hold_id = NULL WHERE token = ? AND declined = 0")
		.bind(offer.token)
		.run();
	if (changed.meta.changes !== 1) return;
	if (offer.hold_id) {
		try {
			await deleteEvent(await accessToken(env.GOOGLE_SERVICE_ACCOUNT), offer.calendar_id, offer.hold_id);
		} catch (error) {
			console.error(error);
		}
	}

	const ended = await env.DB.prepare(
		`UPDATE requests SET status = 'declined' WHERE id = ?1 AND status = 'pending'
		 AND NOT EXISTS (SELECT 1 FROM offers WHERE request_id = ?1 AND declined = 0)`,
	)
		.bind(request.id)
		.run();
	if (ended.meta.changes !== 1) return;
	const time = timeOf(env, request);
	await send(env, [notices.declined(intake, time), notices.nobody(intake, time, env.MAIL_TO)]);
}

export async function act(env: Env, token: string, action: string): Promise<void> {
	const loaded = await load(env.DB, token);
	if (!loaded) return;
	if (action === "confirm") await confirm(env, loaded);
	if (action === "decline") await decline(env, loaded);
}

const escape = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const html = (title: string, body: string, status = 200) =>
	new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
	:root { color-scheme: light dark; --muted: #666; --accent: #1f6feb; --line: #ddd; }
	@media (prefers-color-scheme: dark) { :root { --muted: #aaa; --accent: #58a6ff; --line: #333; } }
	body { font: 1rem/1.5 system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 2rem 1rem; }
	h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
	.state { color: var(--muted); margin: 0 0 1.5rem; }
	pre { white-space: pre-wrap; font: inherit; border: 1px solid var(--line); border-radius: 0.5rem; padding: 1rem; margin: 0 0 1.5rem; }
	form { display: flex; gap: 0.75rem; flex-wrap: wrap; }
	button { font: inherit; font-weight: 600; padding: 0.6rem 1.2rem; border-radius: 0.5rem; border: 1px solid var(--accent); cursor: pointer; background: none; color: var(--accent); }
	button[value="confirm"] { background: var(--accent); color: Canvas; }
</style>
</head>
<body>
${body}
</body>
</html>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
	);

export async function page(env: Env, token: string): Promise<Response> {
	const loaded = await load(env.DB, token);
	if (!loaded) return html("Request not found", "<h1>Request not found</h1><p>This link doesn't match a request.</p>", 404);
	const { offer, request, offers, intake } = loaded;
	const time = timeOf(env, request);
	const taker = offers.find((other) => other.token === request.confirmed_by);

	const take = '<button name="action" value="confirm">Take it</button>';
	const [title, state, buttons] =
		request.status === "confirmed"
			? taker?.token === offer.token
				? ["You took this request", "It's yours, and the customer has been told.", ""]
				: [`${taker?.name ?? "Another tech"} took this request`, "Nothing for you to do.", ""]
			: request.status === "declined"
				? ["Every tech declined this request", "The customer has been told.", ""]
				: passed(request)
					? ["This time has passed", "Nobody took it in time, so it can't be taken now.", ""]
					: offer.declined
						? ["You declined this request", "It's still open for the others, so you can take it after all.", take]
						: [
								"New repair request",
								time ? `For ${stop(time)} The first tech to take it gets it.` : "No time picked. The first tech to take it gets it.",
								`${take}<button name="action" value="decline">Decline</button>`,
							];

	return html(
		title,
		`<h1>${escape(title)}</h1>
<p class="state">${escape(state)}</p>
<pre>${escape(describe(intake, time))}</pre>
${buttons && `<form method="post">${buttons}</form>`}`,
	);
}
