// A request offered to each tech. Their link opens a page that shows the request and lets them
// take or decline it, and mark it done once they've taken it. The page only shows it; the buttons
// POST, because mail scanners open the links in emails and must not take requests by doing so.
// Each link also opens that tech's queue: the repairs they took and haven't marked done.

import { type Mail, sendMail } from "./fastmail.ts";
import { accessToken, bookEvent, createEvent, deleteEvent } from "./google.ts";
import { describe, dialable, formatTime, type Intake, stop, what } from "./intake.ts";
import * as notices from "./notices.ts";
import { escape, html } from "./pages.ts";

interface RequestRow {
	id: string;
	intake: string;
	// Nullable in the schema (0003 says why), but every request has a time.
	slot_start: number;
	slot_end: number;
	status: "pending" | "confirmed" | "declined" | "expired";
	confirmed_by: string | null;
	rush: number; // the fee, 0 for none
	done: number | null; // when the tech who took it marked it done
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

const timeOf = (env: Env, request: RequestRow) => formatTime(request.slot_start, env.TIME_ZONE);

const send = async (env: Env, mails: Omit<Mail, "from">[]) => {
	try {
		await sendMail(env.FASTMAIL_TOKEN, mails.map((mail) => ({ from: env.MAIL_FROM, ...mail })));
	} catch (error) {
		// The request is settled either way; the calendar and this page show where it stands.
		console.error(error);
	}
};

// Once the time has started nobody can take it; the scheduled job expires it.
const passed = (request: RequestRow, now = Date.now()) => request.slot_start <= now;

// First tech to get here takes it: one statement, so two techs pressing at once can't both win. A
// tech who declined can still change their mind while it's open. Other repairs at the same time
// don't stop them: it's a drop-off time, and any number of devices can come in then.
async function confirm(env: Env, { offer, request, offers, intake }: Loaded) {
	const won = await env.DB.prepare(
		`UPDATE requests SET status = 'confirmed', confirmed_by = ?2
		 WHERE id = ?1 AND status = 'pending' AND slot_start > ?3`,
	)
		.bind(request.id, offer.token, Date.now())
		.run();
	if (won.meta.changes !== 1) return;
	await env.DB.prepare("UPDATE offers SET declined = 0 WHERE token = ?").bind(offer.token).run();

	const time = timeOf(env, request);
	// Their hold becomes the booking, or they get a new one if they weren't free when it came
	// in, had declined, or deleted the hold.
	let token: string;
	try {
		token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
		const booking = {
			summary: notices.bookedSummary(intake),
			description: notices.bookedDescription(intake, time, offer.name),
		};
		if (!offer.hold_id || !(await bookEvent(token, offer.calendar_id, offer.hold_id, booking))) {
			await createEvent(
				token,
				offer.calendar_id,
				{ ...booking, start: request.slot_start, end: request.slot_end, timeZone: env.TIME_ZONE },
				true,
			);
		}
	} catch (error) {
		// Not on their calendar, so nobody has it yet: open it again before anyone is told, and the
		// error page tells the tech to try again.
		await env.DB.prepare("UPDATE requests SET status = 'pending', confirmed_by = NULL WHERE id = ? AND confirmed_by = ?")
			.bind(request.id, offer.token)
			.run();
		throw error;
	}

	// Everyone else's hold goes. One that can't be deleted keeps its id, and the hourly job tries again.
	const others = offers.filter((other) => other.token !== offer.token && other.hold_id);
	const results = await Promise.allSettled(
		others.map(async (other) => {
			await deleteEvent(token, other.calendar_id, other.hold_id!);
			await env.DB.prepare("UPDATE offers SET hold_id = NULL WHERE token = ?").bind(other.token).run();
		}),
	);
	for (const result of results) if (result.status === "rejected") console.error(result.reason);

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
	// Checked again here, not only on what was loaded: had they just taken it in another tab, their
	// hold is now the booking and mustn't be deleted.
	const changed = await env.DB.prepare(
		`UPDATE offers SET declined = 1 WHERE token = ?1 AND declined = 0
		 AND (SELECT status FROM requests WHERE id = ?2) = 'pending'`,
	)
		.bind(offer.token, request.id)
		.run();
	if (changed.meta.changes !== 1) return;
	if (offer.hold_id) {
		try {
			await deleteEvent(await accessToken(env.GOOGLE_SERVICE_ACCOUNT), offer.calendar_id, offer.hold_id);
			await env.DB.prepare("UPDATE offers SET hold_id = NULL WHERE token = ? AND declined = 1").bind(offer.token).run();
		} catch (error) {
			// Still on their calendar; the hourly job tries again.
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

// Out of the taker's queue once it's back with the customer. Only they can, and only once.
async function finish(env: Env, { offer, request }: Loaded) {
	await env.DB.prepare(
		"UPDATE requests SET done = ?3 WHERE id = ?1 AND status = 'confirmed' AND confirmed_by = ?2 AND done IS NULL",
	)
		.bind(request.id, offer.token, Date.now())
		.run();
}

// Run by the cron in wrangler.jsonc. Closes the requests nobody took in time and tells the
// customer, then deletes the holds nobody needs any more: a declined tech's, and every hold but
// the booking once a request is settled. Holds whose delete failed earlier are among them. Last,
// it deletes the customer's details once a request is settled and RETENTION_DAYS past its time.
export async function expire(env: Env, now = Date.now()): Promise<void> {
	const { results: expired } = await env.DB.prepare(
		`UPDATE requests SET status = 'expired'
		 WHERE status = 'pending' AND slot_start <= ?1
		 RETURNING *`,
	)
		.bind(now)
		.all<RequestRow>();
	if (expired.length > 0) {
		await send(
			env,
			expired.flatMap((request) => {
				const intake: Intake = JSON.parse(request.intake);
				const time = timeOf(env, request);
				return [notices.expired(intake, time), notices.unclaimed(intake, time, env.MAIL_TO)];
			}),
		);
	}

	const { results: strays } = await env.DB.prepare(
		`SELECT offers.* FROM offers JOIN requests ON requests.id = offers.request_id
		 WHERE offers.hold_id IS NOT NULL AND offers.token IS NOT requests.confirmed_by
		 AND (offers.declined = 1 OR requests.status != 'pending')`,
	).all<OfferRow>();
	if (strays.length > 0) {
		const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
		for (const offer of strays) {
			try {
				await deleteEvent(token, offer.calendar_id, offer.hold_id!);
				await env.DB.prepare("UPDATE offers SET hold_id = NULL WHERE token = ?").bind(offer.token).run();
			} catch (error) {
				// Still on the calendar; the next run tries again.
				console.error(error);
			}
		}
	}

	// Settled: nobody took it, or it's back with the customer. A repair still in someone's queue
	// stays however old it is. Offers first, since they point at the request.
	const settled = `SELECT id FROM requests WHERE slot_start < ?1
		AND (status IN ('declined', 'expired') OR done IS NOT NULL)`;
	const cutoff = now - env.RETENTION_DAYS * 86_400_000;
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM offers WHERE request_id IN (${settled})`).bind(cutoff),
		env.DB.prepare(`DELETE FROM requests WHERE id IN (${settled})`).bind(cutoff),
	]);
}

export async function act(env: Env, token: string, action: string): Promise<void> {
	const loaded = await load(env.DB, token);
	if (!loaded) return;
	if (action === "confirm") await confirm(env, loaded);
	if (action === "decline") await decline(env, loaded);
	if (action === "done") await finish(env, loaded);
}

export async function page(env: Env, token: string): Promise<Response> {
	const loaded = await load(env.DB, token);
	if (!loaded) return html("Request not found", "<h1>Request not found</h1><p>This link doesn't match a request.</p>", 404);
	const { offer, request, offers, intake } = loaded;
	const time = timeOf(env, request);
	const taker = offers.find((other) => other.token === request.confirmed_by);

	const take = '<button name="action" value="confirm">Take it</button>';
	const done = '<button name="action" value="done">Mark done</button>';
	const decline = offer.declined ? "" : '<button name="action" value="decline">Decline</button>';
	const [title, state, buttons] =
		request.status === "confirmed"
			? taker?.token === offer.token
				? request.done !== null
					? ["You finished this repair", "It's out of your queue.", ""]
					: [
							"You took this request",
							"It's yours, and the customer has been told. Agree with them when it'll be ready, and mark it done once it's back with them.",
							done,
						]
				: [`${taker?.name ?? "Another tech"} took this request`, "Nothing for you to do.", ""]
			: request.status === "declined"
				? ["Every tech declined this request", "The customer has been told.", ""]
				: request.status === "expired"
					? ["This request expired", "Nobody took it in time, and the customer has been told.", ""]
					: passed(request)
						? ["This time has passed", "Nobody took it in time, so it can't be taken now.", ""]
						: offer.declined
							? ["You declined this request", "It's still open for the others, so you can take it after all.", take]
							: [
									intake.rush ? "New rush repair request" : "New repair request",
									`Drop-off ${stop(time)} The first tech to take it gets it.`,
									take + decline,
								];

	// Payment is in person, so the fee is only a reminder.
	const rush = intake.rush
		? `<p class="rush">RUSH: +$${intake.rush}, paid in person. It goes to the front of the queue.</p>\n`
		: "";
	// Techs call to talk through the price, so the number is one tap away on a phone.
	const call = `<p class="call"><a href="tel:${escape(dialable(intake.phone))}">Call ${escape(intake.name)}: ${escape(intake.phone)}</a></p>\n`;
	return html(
		title,
		`<h1>${escape(title)}</h1>
<p class="state">${escape(state)}</p>
${rush}${call}<pre>${escape(describe(intake, time))}</pre>
${buttons && `<form method="post">${buttons}</form>`}
<p class="mine"><a href="/offers/${offer.token}/queue">Your queue</a></p>`,
	);
}

// The repairs this tech took and hasn't marked done, in the order to work them: rush first, then
// the earliest drop-off, then the first filed. A tech is their calendar, as everywhere else a
// request meets one. `rush > 0`, not `rush`: a rush is a rush whatever fee it was quoted at.
const QUEUE = `SELECT requests.*, offers.token FROM requests JOIN offers ON offers.token = requests.confirmed_by
	WHERE requests.status = 'confirmed' AND requests.done IS NULL AND offers.calendar_id = ?
	ORDER BY requests.rush > 0 DESC, requests.slot_start, requests.created`;

export async function queue(env: Env, token: string): Promise<Response> {
	const offer = await env.DB.prepare("SELECT * FROM offers WHERE token = ?").bind(token).first<OfferRow>();
	if (!offer) return html("Queue not found", "<h1>Queue not found</h1><p>This link doesn't match a request.</p>", 404);
	const { results } = await env.DB.prepare(QUEUE).bind(offer.calendar_id).all<RequestRow & { token: string }>();

	const items = results.map((request) => {
		const intake: Intake = JSON.parse(request.intake);
		const time = timeOf(env, request);
		// The device too, when the title is the service.
		const details = [`Drop-off ${time}`, intake.service && intake.device, intake.name].filter((detail) => detail);
		const call = ` · <a href="tel:${escape(dialable(intake.phone))}">${escape(intake.phone)}</a>`;
		return `<li><a class="what" href="/offers/${request.token}">${request.rush ? "RUSH " : ""}${escape(what(intake))}</a><br>
<span class="details">${details.map(escape).join(" · ")}${call}</span></li>`;
	});
	const count = `${results.length} repair${results.length === 1 ? "" : "s"}`;
	return html(
		"Your queue",
		`<h1>Your queue</h1>
${
	items.length > 0
		? `<p class="state">${count} you took and haven't marked done: rush first, then by drop-off time. Fewer "Available" blocks on your calendar means fewer new ones.</p>
<ol class="queue">
${items.join("\n")}
</ol>`
		: `<p class="state">Nothing in your queue. Repairs you take show up here until you mark them done.</p>`
}`,
	);
}
