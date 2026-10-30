// The handler end to end, with Google and Fastmail replaced by a fake fetch.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { resetTokenCache } from "./google.ts";
import worker from "./index.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const hour = 3_600_000;
const quarter = hour / 4;
const slotStart = Math.ceil((Date.now() + 24 * hour) / hour) * hour;

const env = {
	SITE_URL: "https://repairs.perocho.com",
	MAIL_FROM: "repairs@perocho.com",
	MAIL_TO: "repairs@perocho.com",
	TIME_ZONE: "America/Toronto",
	SLOT_MINUTES: 15,
	LEAD_HOURS: 2,
	DAYS_AHEAD: 31,
	RUSH_FEE: 20,
	RETENTION_DAYS: 180,
	DEV_ORIGINS: "",
	TECHS: JSON.stringify([
		{ name: "Richard", calendarId: "richard@example.com" },
		{ name: "Sam", calendarId: "sam@example.com" },
	]),
	GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
		client_email: "intake@example.iam.gserviceaccount.com",
		private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
	}),
	FASTMAIL_TOKEN: "fm-token",
	get DB() {
		return db as unknown as D1Database;
	},
	// Lets `allowed` posts through, recording the key of each one it's asked about.
	REQUEST_LIMITER: {
		limit: async ({ key }: { key: string }) => {
			limitKeys.push(key);
			return { success: limitKeys.length <= allowed };
		},
	},
	// Same for /slots, with its own count.
	SLOTS_LIMITER: {
		limit: async ({ key }: { key: string }) => {
			slotsLimitKeys.push(key);
			return { success: slotsLimitKeys.length <= slotsAllowed };
		},
	},
};

// D1 on top of an in-memory SQLite with the real migrations, for the few calls the worker makes.
function fakeD1() {
	const sqlite = new DatabaseSync(":memory:");
	const migrations = `${import.meta.dirname}/../migrations`;
	for (const file of readdirSync(migrations).sort()) sqlite.exec(readFileSync(`${migrations}/${file}`, "utf8"));
	const statement = (sql: string, params: any[] = []) => ({
		bind: (...values: any[]) => statement(sql, values),
		run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
		first: async () => sqlite.prepare(sql).get(...params) ?? null,
		all: async () => ({ success: true, results: sqlite.prepare(sql).all(...params) }),
	});
	return {
		sqlite,
		prepare: (sql: string) => statement(sql),
		batch: async (statements: ReturnType<typeof statement>[]) => {
			sqlite.exec("BEGIN");
			try {
				const results = [];
				for (const s of statements) results.push(await s.run());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

const iso = (ms: number) => new Date(ms).toISOString();
let db: ReturnType<typeof fakeD1>;
let patched: { calendarId: string; eventId: string; body: any }[];
let calendars: Record<string, object[]>;
let holds: { calendarId: string; body: any }[];
let deleted: { calendarId: string; eventId: string }[];
let mails: any[];
let submissions: any[];
let tokenRequests: number;
let tokenLifetime: number; // seconds, as Google's expires_in
let fetches: string[];
let limitKeys: string[];
let allowed: number;
let slotsLimitKeys: string[];
let slotsAllowed: number;

beforeEach(() => {
	// Both are available every hour for the next two weeks. Richard is busy at the slot; Sam is
	// free. Both are busy the hour after.
	const available = { summary: "Available", start: { dateTime: iso(slotStart - 24 * hour) }, end: { dateTime: iso(slotStart + 13 * 24 * hour) } };
	calendars = {
		"richard@example.com": [
			available,
			{ summary: "Dentist", start: { dateTime: iso(slotStart) }, end: { dateTime: iso(slotStart + 2 * hour) } },
		],
		"sam@example.com": [
			available,
			{ summary: "Gym", start: { dateTime: iso(slotStart + hour) }, end: { dateTime: iso(slotStart + 2 * hour) } },
		],
	};
	db = fakeD1();
	holds = [];
	deleted = [];
	patched = [];
	mails = [];
	submissions = [];
	tokenRequests = 0;
	tokenLifetime = 3600;
	resetTokenCache();
	fetches = [];
	limitKeys = [];
	allowed = Infinity;
	slotsLimitKeys = [];
	slotsAllowed = Infinity;

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		fetches.push(url.href);
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		if (url.href === "https://oauth2.googleapis.com/token") {
			tokenRequests++;
			return Response.json({ access_token: "google-token", expires_in: tokenLifetime });
		}
		const event = url.pathname.match(/\/calendars\/([^/]+)\/events\/([^/]+)$/);
		if (event && init?.method === "PATCH") {
			const [calendarId, eventId] = [event[1], event[2]].map(decodeURIComponent);
			const found: any = calendars[calendarId].find((e: any) => e.id === eventId);
			if (!found) return new Response("gone", { status: 404 });
			patched.push({ calendarId, eventId, body });
			Object.assign(found, body);
			return Response.json({ id: eventId });
		}
		if (event && init?.method === "DELETE") {
			const [calendarId, eventId] = [event[1], event[2]].map(decodeURIComponent);
			deleted.push({ calendarId, eventId });
			calendars[calendarId] = calendars[calendarId].filter((e: any) => e.id !== eventId);
			return new Response(null, { status: 204 });
		}
		const calendar = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
		if (calendar) {
			const calendarId = decodeURIComponent(calendar[1]);
			if (!calendars[calendarId]) return new Response("Not Found", { status: 404 });
			if (init?.method === "POST") {
				holds.push({ calendarId, body });
				const id = `hold${holds.length}`;
				calendars[calendarId].push({ ...body, id });
				return Response.json({ id });
			}
			return Response.json({ items: calendars[calendarId] });
		}
		if (url.href === "https://api.fastmail.com/jmap/session") {
			return Response.json({
				apiUrl: "https://api.fastmail.com/jmap/api/",
				primaryAccounts: { "urn:ietf:params:jmap:mail": "acc" },
			});
		}
		if (url.href === "https://api.fastmail.com/jmap/api/") {
			const [[method]] = body.methodCalls;
			if (method === "Identity/get") {
				return Response.json({
					methodResponses: [
						["Identity/get", { list: [{ id: "id1", name: "Perocho Repairs", email: "repairs@perocho.com" }] }, "identities"],
						["Mailbox/query", { ids: ["drafts"] }, "drafts"],
						["Mailbox/query", { ids: ["sent"] }, "sent"],
					],
				});
			}
			const drafts = body.methodCalls[0][1].create;
			mails.push(...Object.values(drafts));
			submissions.push(body.methodCalls[1][1]);
			return Response.json({
				methodResponses: [
					["Email/set", { created: drafts }, "email"],
					["EmailSubmission/set", { created: body.methodCalls[1][1].create }, "submission"],
				],
			});
		}
		throw new Error(`unexpected fetch ${url}`);
	};
});

const submit = (fields: Record<string, string>, headers: Record<string, string> = {}, overrides = {}) => {
	const body = new URLSearchParams({
		name: "Jane",
		email: "jane@example.com",
		service: "PS5 deep cleaning",
		device: "PS5 disc",
		phone: "(416) 555-0123",
		problem: "Loud fan",
		slot: iso(slotStart),
		...fields,
	});
	return worker.fetch(new Request("https://intake.test/request", { method: "POST", body, headers }), { ...env, ...overrides });
};

test("lists only times when some tech is free", async () => {
	const response = await worker.fetch(new Request("https://intake.test/slots"), env);
	const { timeZone, slots } = (await response.json()) as { timeZone: string; slots: { start: string }[] };
	assert.equal(timeZone, env.TIME_ZONE);
	const starts = slots.map((s) => s.start);
	assert.ok(starts.includes(iso(slotStart)));
	assert.ok(starts.includes(iso(slotStart + 3 * quarter)));
	assert.ok(!starts.includes(iso(slotStart + hour)));
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), env.SITE_URL);
	assert.equal(response.headers.get("Cache-Control"), "no-cache");
});

const slotsFrom = (origin: string, overrides = {}) =>
	worker.fetch(new Request("https://intake.test/slots", { headers: { Origin: origin } }), {
		...env,
		...overrides,
	});

test("lets the site read the times", async () => {
	const response = await slotsFrom("https://repairs.perocho.com");
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://repairs.perocho.com");
	assert.equal(response.headers.get("Vary"), "Origin");
});

test("lets other origins read the times only when DEV_ORIGINS lists them", async () => {
	const local = "http://localhost:4321";
	const production = await slotsFrom(local);
	assert.equal(production.headers.get("Access-Control-Allow-Origin"), env.SITE_URL);

	const dev = await slotsFrom(local, { DEV_ORIGINS: `http://127.0.0.1:4321, ${local}` });
	assert.equal(dev.headers.get("Access-Control-Allow-Origin"), local);
	const other = await slotsFrom("https://evil.example", { DEV_ORIGINS: local });
	assert.equal(other.headers.get("Access-Control-Allow-Origin"), env.SITE_URL);
});

for (const [label, TECHS] of [
	["not JSON", "{oops"],
	["not an array", JSON.stringify({ name: "Ann", calendarId: "ann@example.com" })],
	["an entry without calendarId", JSON.stringify([{ name: "Ann" }])],
]) {
	test(`fails clearly when TECHS is ${label}`, async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (error) => errors.push(error);
		const response = await slotsFrom("https://repairs.perocho.com", { TECHS });
		console.error = original;
		assert.equal(response.status, 500);
		assert.equal(errors.length, 1);
		const message = (errors[0] as Error).message;
		assert.match(message, /^TECHS /);
		assert.ok(!message.includes("Ann") && !message.includes("oops"));
	});
}

const getSlots = () => worker.fetch(new Request("https://intake.test/slots"), env);
const to = (address: string) => mails.filter((mail) => mail.to[0].email === address);
const text = (mail: any) => mail.bodyValues.body.value as string;
const linkFor = (address: string) => text(to(address)[0]).match(/https:\/\/intake\.test\/offers\/[0-9a-f-]+/)![0];

test("holds the picked time on the free tech's calendar and offers it to every tech", async () => {
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");

	assert.equal(holds.length, 1);
	assert.equal(holds[0].calendarId, "sam@example.com");
	assert.equal(holds[0].body.status, "tentative");
	assert.equal(holds[0].body.transparency, "transparent");
	assert.equal(holds[0].body.end.dateTime, iso(slotStart + quarter));
	assert.equal(holds[0].body.summary, "Request: PS5 deep cleaning (Jane)");
	assert.ok(holds[0].body.description.includes(linkFor("sam@example.com")));

	// Richard is busy then but still hears of it, with his own link.
	assert.deepEqual(mails.map((mail) => mail.to[0].email), ["richard@example.com", "sam@example.com", "repairs@perocho.com", "jane@example.com"]);
	assert.notEqual(linkFor("richard@example.com"), linkFor("sam@example.com"));
	assert.deepEqual(to("sam@example.com")[0].replyTo, [{ email: "jane@example.com" }]);
	assert.match(text(to("sam@example.com")[0]), /tentative hold/);
	assert.doesNotMatch(text(to("richard@example.com")[0]), /tentative hold/);
	assert.doesNotMatch(text(to("repairs@perocho.com")[0]), /offers/);
	assert.match(text(to("repairs@perocho.com")[0]), /Sent to: Richard, Sam\nHeld on: Sam \(tentative\)/);
	assert.match(to("jane@example.com")[0].subject, /^We got your repair request/);
	assert.equal(to("jane@example.com")[0].replyTo, undefined);
});

test("holds the time on every tech who's free then", async () => {
	calendars["richard@example.com"].pop(); // no dentist
	await submit({ slot: iso(slotStart) });
	assert.deepEqual(holds.map((hold) => hold.calendarId), ["richard@example.com", "sam@example.com"]);
	const offers = db.sqlite.prepare("SELECT name, hold_id FROM offers ORDER BY position").all();
	assert.deepEqual(offers.map((o: any) => [o.name, o.hold_id]), [["Richard", "hold1"], ["Sam", "hold2"]]);
});

test("turns away a request without a time before calling Google or Fastmail", async () => {
	const response = await submit({ slot: "" });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
	assert.deepEqual(fetches, []);
	assert.deepEqual(limitKeys, []);
});

test("gives the phone number in every summary", async () => {
	await submit({});
	for (const mail of mails) assert.match(text(mail), /\nPhone: \(416\) 555-0123\n/);
	assert.match(holds[0].body.description, /Phone: \(416\) 555-0123/);
	assert.match(text(to("sam@example.com")[0]), /Drop-off time: /);
});

test("emails a tech at their email when TECHS gives one", async () => {
	await submit({}, {}, { TECHS: JSON.stringify([{ name: "Sam", calendarId: "sam@example.com", email: "sam@work.example" }]) });
	assert.equal(to("sam@work.example").length, 1);
	assert.equal(to("sam@example.com").length, 0);
});

test("sends people back when the time isn't open any more", async () => {
	calendars["sam@example.com"].push({
		summary: "Lunch",
		start: { dateTime: iso(slotStart) },
		end: { dateTime: iso(slotStart + hour) },
	});
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/closed/");
	assert.equal(holds.length + mails.length, 0);
});

test("any number of requests can share a drop-off time", async () => {
	await submit({ slot: iso(slotStart) });
	const second = await submit({ slot: iso(slotStart), name: "Bob", email: "bob@example.com" });
	assert.equal(second.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.deepEqual(holds.map((hold) => hold.calendarId), ["sam@example.com", "sam@example.com"]);
	assert.equal(deleted.length, 0);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM requests").get()!.n, 2);

	// Both holds are on Sam's calendar, and the time is still offered.
	const { slots } = (await (await getSlots()).json()) as { slots: { start: string }[] };
	assert.ok(slots.some((slot) => slot.start === iso(slotStart)));
});

test("drops honeypot submissions quietly", async () => {
	const response = await submit({ website: "spam" });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(mails.length, 0);
});

test("reuses the Google token across requests", async () => {
	await getSlots();
	await submit({ slot: iso(slotStart) });
	assert.equal(tokenRequests, 1);
});

test("gets a new token within 5 minutes of expiry", async () => {
	tokenLifetime = 299;
	await getSlots();
	await getSlots();
	assert.equal(tokenRequests, 2);
});

test("the same request sent twice is filed once", async () => {
	const first = await submit({});
	const sent = mails.length;
	const second = await submit({});
	for (const response of [first, second]) {
		assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	}
	assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM requests").get()!.n, 1);
	assert.equal(mails.length, sent);
});

test("the same request sent again a while later is a new one", async () => {
	await submit({});
	db.sqlite.prepare("UPDATE requests SET created = ?").run(Date.now() - hour);
	await submit({});
	assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM requests").get()!.n, 2);
});

test("re-reads the calendars on submit, not what /slots last saw", async () => {
	await getSlots();
	calendars["sam@example.com"].push({
		start: { dateTime: iso(slotStart) },
		end: { dateTime: iso(slotStart + hour) },
	});
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/closed/");
	assert.equal(holds.length, 0);
});

test("counts a held request as sent when only the email fails", async () => {
	const fake = globalThis.fetch;
	globalThis.fetch = async (input, init) =>
		String(input) === "https://api.fastmail.com/jmap/api/"
			? new Response("down", { status: 503 })
			: fake(input, init);
	const errors: unknown[] = [];
	const original = console.error;
	console.error = (error) => errors.push(error);
	const response = await submit({ slot: iso(slotStart) });
	console.error = original;
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(holds.length, 1);
	assert.match(holds[0].body.description, /Loud fan/);
	assert.match(holds[0].body.description, /\/offers\//);
	assert.equal(errors.length, 1);
});

test("sends people to the failure page when a service is down", async () => {
	globalThis.fetch = async () => new Response("down", { status: 503 });
	const original = console.error;
	console.error = () => {};
	const response = await submit({});
	console.error = original;
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
	// The techs never heard of it, so it isn't kept.
	assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM requests").get()!.n, 0);
});

test("emails the customer when their request fails", async () => {
	const fake = globalThis.fetch;
	globalThis.fetch = async (input, init) =>
		String(input) === "https://oauth2.googleapis.com/token" ? new Response("down", { status: 503 }) : fake(input, init);
	const original = console.error;
	console.error = () => {};
	const response = await submit({ slot: iso(slotStart) });
	console.error = original;
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
	assert.deepEqual(mails.map((mail) => mail.to[0].email), ["jane@example.com"]);
	assert.match(mails[0].subject, /didn't go through/);
});

const quietly = async <T>(run: () => Promise<T>) => {
	const original = console.warn;
	console.warn = () => {};
	try {
		return await run();
	} finally {
		console.warn = original;
	}
};

test("turns away a visitor over the rate limit before calling Google or Fastmail", async () => {
	allowed = 0;
	const response = await quietly(() => submit({ slot: iso(slotStart) }, { "CF-Connecting-IP": "203.0.113.7" }));
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
	assert.deepEqual(fetches, []);
	assert.equal(holds.length + mails.length, 0);
});

test("turns away a visitor fetching /slots too often before calling Google", async () => {
	slotsAllowed = 0;
	const response = await quietly(() =>
		worker.fetch(new Request("https://intake.test/slots", { headers: { "CF-Connecting-IP": "203.0.113.7" } }), env),
	);
	assert.equal(response.status, 429);
	assert.deepEqual(fetches, []);
	assert.deepEqual(slotsLimitKeys, ["203.0.113.7"]);
	assert.deepEqual(limitKeys, []);
});

test("counts each valid post against the visitor's IP", async () => {
	allowed = 1;
	const first = await submit({ slot: iso(slotStart) }, { "CF-Connecting-IP": "203.0.113.7" });
	assert.equal(first.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(holds.length, 1);
	assert.equal(mails.length, 4);
	assert.deepEqual(limitKeys, ["203.0.113.7"]);

	// Nobody is emailed, the customer included: the form mustn't be a way to flood an inbox.
	const second = await quietly(() => submit({ name: "Bob" }, { "CF-Connecting-IP": "203.0.113.7" }));
	assert.equal(second.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
	assert.equal(mails.length, 4);
});

test("shares one count between posts without a visitor IP", async () => {
	await submit({});
	assert.deepEqual(limitKeys, ["unknown"]);
});

test("doesn't count honeypot or invalid posts", async () => {
	await submit({ website: "spam" });
	await submit({ name: "" });
	await submit({ phone: "555-0123" });
	assert.deepEqual(limitKeys, []);
});

test("doesn't keep a Sent copy of mail to our own address", async () => {
	await submit({});
	// Richard, Sam, repairs@ (ourselves), Jane.
	assert.deepEqual(submissions[0].onSuccessDestroyEmail, ["#send2"]);
	assert.deepEqual(Object.keys(submissions[0].onSuccessUpdateEmail), ["#send0", "#send1", "#send3"]);
	assert.equal(submissions[0].onSuccessUpdateEmail["#send0"]["mailboxIds/sent"], true);
});

// The offer links.

const offerPage = (link: string) => worker.fetch(new Request(link), env);
const press = (link: string, action: string) =>
	worker.fetch(new Request(link, { method: "POST", body: new URLSearchParams({ action }) }), env);
const status = () => (db.sqlite.prepare("SELECT status FROM requests").get() as any).status;
const both = () => calendars["richard@example.com"].pop(); // frees Richard, so both get holds

test("shows a tech the request without changing anything", async () => {
	await submit({ slot: iso(slotStart) });
	const response = await offerPage(linkFor("sam@example.com"));
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /New repair request/);
	assert.match(body, /Loud fan/);
	assert.match(body, /<a href="tel:4165550123">Call Jane: \(416\) 555-0123<\/a>/);
	assert.match(body, /<form method="post">/);
	assert.match(body, /value="confirm"/);
	assert.match(body, /value="decline"/);
	assert.equal(status(), "pending");
	assert.equal(patched.length + deleted.length, 0);
});

test("locks the tech's pages down to their own styles and forms", async () => {
	await submit({ slot: iso(slotStart) });
	const sam = linkFor("sam@example.com");
	const unknown = "https://intake.test/offers/00000000-0000-4000-8000-000000000000";
	for (const link of [sam, `${sam}/queue`, unknown]) {
		assert.equal(
			(await offerPage(link)).headers.get("Content-Security-Policy"),
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		);
	}
});

test("escapes what the customer wrote on the page", async () => {
	await submit({ problem: "<script>alert(1)</script>" });
	const body = await (await offerPage(linkFor("sam@example.com"))).text();
	assert.ok(!body.includes("<script>alert"));
	assert.match(body, /&lt;script&gt;/);
});

test("keeps tags out of what the customer wrote on the calendar", async () => {
	await submit({ slot: iso(slotStart), problem: '<a href="https://evil.example">Take it</a>' });
	const { description } = holds[0].body;
	assert.ok(!description.includes("<a"));
	assert.match(description, /‹a href="https:\/\/evil\.example"›Take it‹\/a›/);
});

test("answers an unknown link with 404", async () => {
	const response = await offerPage("https://intake.test/offers/00000000-0000-4000-8000-000000000000");
	assert.equal(response.status, 404);
});

test("a post to a link that isn't a form changes nothing", async () => {
	await submit({ slot: iso(slotStart) });
	const sam = linkFor("sam@example.com");
	for (const init of [{}, { body: "{}", headers: { "Content-Type": "application/json" } }]) {
		const response = await worker.fetch(new Request(sam, { method: "POST", ...init }), env);
		assert.equal(response.status, 303);
	}
	assert.equal(status(), "pending");
});

test("the first tech to take it books it and everyone hears", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const [richard, sam] = [linkFor("richard@example.com"), linkFor("sam@example.com")];
	mails = [];

	const response = await press(sam, "confirm");
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("Location"), sam);
	assert.equal(status(), "confirmed");

	// Sam's hold is now the booking; Richard's is gone.
	assert.equal(patched.length, 1);
	assert.equal(patched[0].calendarId, "sam@example.com");
	assert.equal(patched[0].body.status, "confirmed");
	assert.equal(patched[0].body.transparency, "transparent");
	assert.equal(patched[0].body.summary, "Repair: PS5 deep cleaning (Jane)");
	assert.deepEqual(deleted, [{ calendarId: "richard@example.com", eventId: "hold1" }]);

	assert.deepEqual(mails.map((mail) => mail.to[0].email), ["jane@example.com", "richard@example.com", "repairs@perocho.com"]);
	assert.match(to("jane@example.com")[0].subject, /^Your repair is confirmed/);
	assert.match(text(to("jane@example.com")[0]), /Sam has confirmed your repair/);
	assert.match(to("richard@example.com")[0].subject, /^Taken by Sam/);

	// Too late for Richard: nothing changes, and his page says who took it.
	mails = [];
	await press(richard, "confirm");
	await press(richard, "decline");
	assert.equal(mails.length, 0);
	assert.equal(patched.length, 1);
	assert.match(await (await offerPage(richard)).text(), /Sam took this request/);
	assert.match(await (await offerPage(sam)).text(), /You took this request/);
});

test("a tech without a hold gets the booking created when they take it", async () => {
	await submit({ slot: iso(slotStart) }); // Richard was busy, so only Sam holds it
	await press(linkFor("richard@example.com"), "confirm");
	const booking = holds.find((hold) => hold.calendarId === "richard@example.com");
	assert.equal(booking?.body.status, "confirmed");
	assert.equal(booking?.body.transparency, "transparent");
	assert.equal(booking?.body.end.dateTime, iso(slotStart + quarter));
	assert.deepEqual(deleted, [{ calendarId: "sam@example.com", eventId: "hold1" }]);
});

test("declining only takes that tech out, until nobody's left", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const [richard, sam] = [linkFor("richard@example.com"), linkFor("sam@example.com")];
	mails = [];

	await press(richard, "decline");
	assert.equal(status(), "pending");
	assert.deepEqual(deleted, [{ calendarId: "richard@example.com", eventId: "hold1" }]);
	assert.equal(mails.length, 0);
	assert.match(await (await offerPage(richard)).text(), /You declined this request/);

	await press(sam, "decline");
	assert.equal(status(), "declined");
	assert.deepEqual(mails.map((mail) => mail.to[0].email), ["jane@example.com", "repairs@perocho.com"]);
	assert.match(to("jane@example.com")[0].subject, /^We can't take your repair request/);
	assert.match(await (await offerPage(sam)).text(), /Every tech declined/);
});

test("a tech who declined can still take it while it's open", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const richard = linkFor("richard@example.com");
	await press(richard, "decline");
	await press(richard, "confirm");
	assert.equal(status(), "confirmed");
	// His hold went when he declined, so the booking is a new event.
	assert.equal(holds.at(-1)!.calendarId, "richard@example.com");
	assert.equal(holds.at(-1)!.body.status, "confirmed");
});

test("nobody can take it once the time has started", async () => {
	await submit({ slot: iso(slotStart) });
	db.sqlite.prepare("UPDATE requests SET slot_start = ?, slot_end = ?").run(Date.now() - hour, Date.now());
	const sam = linkFor("sam@example.com");
	mails = [];
	await press(sam, "confirm");
	assert.equal(status(), "pending");
	assert.equal(mails.length + patched.length, 0);
	const body = await (await offerPage(sam)).text();
	assert.match(body, /This time has passed/);
	assert.ok(!body.includes("<form"));
});

test("a tech can take two repairs dropped off at the same time", async () => {
	await submit({ slot: iso(slotStart) });
	await submit({ slot: iso(slotStart), name: "Bob", email: "bob@example.com" });
	const [jane, bob] = to("sam@example.com").map((mail) => text(mail).match(/https:\/\/intake\.test\/offers\/[0-9a-f-]+/)![0]);
	await press(jane, "confirm");
	await press(bob, "confirm");
	const rows = db.sqlite.prepare("SELECT status FROM requests").all();
	assert.deepEqual(rows.map((row: any) => row.status), ["confirmed", "confirmed"]);
});

test("two techs pressing take at once: exactly one gets it", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const [richard, sam] = [linkFor("richard@example.com"), linkFor("sam@example.com")];
	mails = [];
	await Promise.all([press(richard, "confirm"), press(sam, "confirm")]);
	assert.equal(status(), "confirmed");
	assert.equal(patched.length, 1);
	assert.equal(to("jane@example.com").length, 1);
});

test("a rush is marked everywhere the techs look, and priced for the customer", async () => {
	both();
	await submit({ slot: iso(slotStart), rush: "1" });
	assert.equal((db.sqlite.prepare("SELECT rush FROM requests").get() as any).rush, 20);
	assert.equal(holds[0].body.summary, "Request: RUSH PS5 deep cleaning (Jane)");
	assert.match(holds[0].body.description, /Rush: yes, \+\$20/);
	assert.match(to("sam@example.com")[0].subject, /^Repair request: RUSH PS5 deep cleaning from Jane, /);
	assert.match(to("repairs@perocho.com")[0].subject, /RUSH/);
	assert.match(text(to("jane@example.com")[0]), /front of the queue\. That's \+\$20, paid in person/);
	assert.doesNotMatch(to("jane@example.com")[0].subject, /RUSH/);

	const sam = linkFor("sam@example.com");
	const page = await (await offerPage(sam)).text();
	assert.match(page, /New rush repair request/);
	assert.match(page, /RUSH: \+\$20, paid in person/);

	mails = [];
	await press(sam, "confirm");
	assert.equal(patched[0].body.summary, "Repair: RUSH PS5 deep cleaning (Jane)");
	assert.match(to("richard@example.com")[0].subject, /^Taken by Sam: RUSH /);
	assert.match(text(to("jane@example.com")[0]), /\+\$20/);
});

test("a request without a rush says nothing about one", async () => {
	await submit({ slot: iso(slotStart) });
	for (const mail of mails) assert.doesNotMatch(mail.subject + text(mail), /rush/i);
	const page = await (await offerPage(linkFor("sam@example.com"))).text();
	assert.doesNotMatch(page.split("<body>")[1], /rush/i);
});

// Google answers every `method` request with a 403, until the returned function is called.
const failing = (method: string) => {
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) =>
		init?.method === method ? new Response("nope", { status: 403 }) : original(input, init);
	return () => (globalThis.fetch = original);
};

test("nothing is confirmed until the booking is on the calendar", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const sam = linkFor("sam@example.com");
	mails = [];
	const restore = failing("PATCH");
	const errors: unknown[] = [];
	const original = console.error;
	console.error = (error) => errors.push(error);
	const response = await press(sam, "confirm");
	console.error = original;
	restore();

	assert.equal(response.status, 500);
	assert.match(await response.text(), /nothing changed/);
	assert.equal(errors.length, 1);
	assert.equal(status(), "pending");
	assert.equal(mails.length + deleted.length, 0);
	assert.match(await (await offerPage(sam)).text(), /New repair request/);

	await press(sam, "confirm");
	assert.equal(status(), "confirmed");
	assert.match(to("jane@example.com")[0].subject, /^Your repair is confirmed/);
});

// The hourly job.

const tick = () => worker.scheduled({} as ScheduledController, env as unknown as Env);
const holdIds = () => db.sqlite.prepare("SELECT hold_id FROM offers ORDER BY position").all().map((row: any) => row.hold_id);

test("expires a request nobody took once its time starts, and lets the holds go", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const sam = linkFor("sam@example.com");
	await tick();
	assert.equal(status(), "pending");

	db.sqlite.prepare("UPDATE requests SET slot_start = ?, slot_end = ?").run(Date.now() - hour, Date.now());
	mails = [];
	await tick();
	assert.equal(status(), "expired");
	assert.deepEqual(mails.map((mail) => mail.to[0].email), ["jane@example.com", "repairs@perocho.com"]);
	assert.match(to("jane@example.com")[0].subject, /^We couldn't take your repair request/);
	assert.match(to("repairs@perocho.com")[0].subject, /^Nobody took/);
	assert.deepEqual(deleted.map((d) => d.calendarId).sort(), ["richard@example.com", "sam@example.com"]);
	assert.deepEqual(holdIds(), [null, null]);
	assert.match(await (await offerPage(sam)).text(), /This request expired/);

	// Done once.
	mails = [];
	await tick();
	assert.equal(mails.length, 0);
	assert.equal(deleted.length, 2);
});

// Runs `f` with Google failing every `method` request, and errors kept off the test output.
const withFailing = async (method: string, f: () => Promise<unknown>) => {
	const [restore, original] = [failing(method), console.error];
	console.error = () => {};
	try {
		await f();
	} finally {
		restore();
		console.error = original;
	}
};

test("the hourly job deletes a declined tech's hold that couldn't be deleted at the time", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	await withFailing("DELETE", () => press(linkFor("richard@example.com"), "decline"));
	assert.deepEqual(holdIds(), ["hold1", "hold2"]);
	await tick();
	assert.deepEqual(holdIds(), [null, "hold2"]);
	assert.ok(!calendars["richard@example.com"].some((e: any) => e.id === "hold1"));
});

test("the hourly job deletes another tech's hold that couldn't be deleted when one took it", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	await withFailing("DELETE", () => press(linkFor("sam@example.com"), "confirm"));
	assert.equal(status(), "confirmed");
	assert.deepEqual(holdIds(), ["hold1", "hold2"]);
	await tick();
	assert.deepEqual(holdIds(), [null, "hold2"]);
	assert.ok(!calendars["richard@example.com"].some((e: any) => e.id === "hold1"));
	assert.ok(calendars["sam@example.com"].some((e: any) => e.id === "hold2"));
});

test("the hourly job leaves the booking alone", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	await press(linkFor("sam@example.com"), "confirm");
	deleted = [];
	await tick();
	assert.ok(!deleted.some((d) => d.calendarId === "sam@example.com"));
	assert.equal(calendars["sam@example.com"].filter((e: any) => e.status === "confirmed").length, 1);
});

test("taking it in one tab and declining in another keeps the booking", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const sam = linkFor("sam@example.com");

	// The decline loads the request while it's open, then waits while the confirm goes through.
	let resume!: () => void;
	const paused = new Promise<void>((resolve) => (resume = resolve));
	const prepare = db.prepare;
	db.prepare = (sql: string) => {
		const statement = prepare(sql);
		if (!sql.startsWith("UPDATE offers SET declined = 1")) return statement;
		return {
			...statement,
			bind: (...values: any[]) => {
				const bound = statement.bind(...values);
				return { ...bound, run: async () => (await paused, bound.run()) };
			},
		};
	};
	const declining = press(sam, "decline");
	await press(sam, "confirm");
	resume();
	await declining;
	db.prepare = prepare;

	assert.equal(status(), "confirmed");
	assert.ok(!deleted.some((d) => d.calendarId === "sam@example.com"));
	assert.equal(calendars["sam@example.com"].filter((e: any) => e.status === "confirmed").length, 1);
});

test("one unreadable calendar costs only that tech their times", async () => {
	const errors: unknown[] = [];
	const original = console.error;
	console.error = (message) => errors.push(message);
	const TECHS = JSON.stringify([
		{ name: "Typo", calendarId: "nobody@example.com" },
		{ name: "Sam", calendarId: "sam@example.com" },
	]);
	const response = await slotsFrom("https://repairs.perocho.com", { TECHS });
	const submitted = await submit({ slot: iso(slotStart) }, {}, { TECHS });
	console.error = original;

	assert.equal(response.status, 200);
	const { slots } = (await response.json()) as { slots: { start: string }[] };
	assert.ok(slots.some((s) => s.start === iso(slotStart)));
	assert.equal(submitted.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.deepEqual(holds.map((hold) => hold.calendarId), ["sam@example.com"]);
	assert.ok(errors.some((e) => String(e).includes("can't read Typo's calendar")));
});

test("fails when no calendar can be read", async () => {
	const original = console.error;
	console.error = () => {};
	const response = await slotsFrom("https://repairs.perocho.com", { TECHS: JSON.stringify([{ name: "Typo", calendarId: "nobody@example.com" }]) });
	console.error = original;
	assert.equal(response.status, 500);
});

// The queue.

test("the queue migration clears the test rows and adds the queue's columns", () => {
	const sqlite = new DatabaseSync(":memory:");
	const migrations = `${import.meta.dirname}/../migrations`;
	const files = readdirSync(migrations).sort();
	const run = (file: string) => sqlite.exec(readFileSync(`${migrations}/${file}`, "utf8"));
	files.slice(0, 2).forEach(run);
	// An old test row from before times were required, with an offer pointing at it.
	sqlite.prepare("INSERT INTO requests (id, created, intake) VALUES ('old', 0, '{}')").run();
	sqlite.prepare("INSERT INTO offers (token, request_id, position, name, email, calendar_id) VALUES ('t', 'old', 0, 'Sam', 's', 's')").run();
	run(files[2]);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM requests").get()!.n, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM offers").get()!.n, 0);
	sqlite.prepare("INSERT INTO requests (id, created, intake, slot_start, slot_end) VALUES ('new', 0, '{}', 1, 2)").run();
	assert.deepEqual({ ...sqlite.prepare("SELECT rush, done FROM requests").get() }, { rush: 0, done: null });
});

const queueOf = (link: string) => worker.fetch(new Request(`${link}/queue`), env);
// Files a request for Sam alone at `slot` and has him take it; returns his link to it.
const taken = async (fields: Record<string, string>) => {
	mails = [];
	await submit(fields);
	const link = linkFor("sam@example.com");
	await press(link, "confirm");
	return link;
};

test("the queue lists a tech's repairs, rush first, then by drop-off", async () => {
	const later = await taken({ slot: iso(slotStart + 2 * quarter), name: "Later" });
	await taken({ slot: iso(slotStart), name: "Early", phone: "416-555-0199" });
	await taken({ slot: iso(slotStart + 3 * quarter), name: "Rushed", rush: "1" });

	const response = await queueOf(later);
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.deepEqual([...body.matchAll(/PS5 disc · (\w+)/g)].map((match) => match[1]), ["Rushed", "Early", "Later"]);
	assert.match(body, /3 repairs/);
	assert.match(body, /<a class="what" href="\/offers\/[0-9a-f-]+">RUSH PS5 deep cleaning<\/a>/);
	assert.match(body, /<a href="tel:4165550199">416-555-0199<\/a>/);
	assert.match(body, /Drop-off \w{3}, /);
	assert.match(await (await offerPage(later)).text(), new RegExp(`<a href="${new URL(later).pathname}/queue">Your queue</a>`));
});

test("the queue only has the tech's own repairs, and none still open", async () => {
	both();
	await submit({ slot: iso(slotStart) }); // open: in nobody's queue
	const [richard, sam] = [linkFor("richard@example.com"), linkFor("sam@example.com")];
	assert.match(await (await queueOf(sam)).text(), /Nothing in your queue/);
	await press(richard, "confirm");
	assert.match(await (await queueOf(sam)).text(), /Nothing in your queue/);
	assert.match(await (await queueOf(richard)).text(), /1 repair /);
});

test("escapes what the customer wrote in the queue", async () => {
	const link = await taken({ name: "<b>Jane</b>", device: "<i>PS5</i>" });
	const body = await (await queueOf(link)).text();
	assert.ok(!body.includes("<b>Jane") && !body.includes("<i>PS5"));
	assert.match(body, /&lt;b&gt;Jane/);
});

test("only the tech who took it can mark it done, and then it leaves the queue", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	const [richard, sam] = [linkFor("richard@example.com"), linkFor("sam@example.com")];
	await press(richard, "done"); // still open: nothing to finish
	assert.equal((db.sqlite.prepare("SELECT done FROM requests").get() as any).done, null);
	await press(sam, "confirm");
	assert.match(await (await offerPage(sam)).text(), /value="done">Mark done/);
	assert.doesNotMatch(await (await offerPage(richard)).text(), /value="done"/);

	await press(richard, "done");
	assert.equal((db.sqlite.prepare("SELECT done FROM requests").get() as any).done, null);
	mails = [];
	await press(sam, "done");
	assert.ok((db.sqlite.prepare("SELECT done FROM requests").get() as any).done > 0);
	assert.equal(status(), "confirmed");
	assert.equal(mails.length, 0);

	const page = await (await offerPage(sam)).text();
	assert.match(page, /You finished this repair/);
	assert.ok(!page.includes("<form"));
	assert.match(await (await queueOf(sam)).text(), /Nothing in your queue/);
	assert.match(await (await offerPage(richard)).text(), /Sam took this request/);
});

test("the hourly job leaves a finished repair and its booking alone", async () => {
	const sam = await taken({});
	await press(sam, "done");
	db.sqlite.prepare("UPDATE requests SET slot_start = ?, slot_end = ?").run(Date.now() - hour, Date.now());
	deleted = [];
	mails = [];
	await tick();
	assert.equal(status(), "confirmed");
	assert.equal(deleted.length + mails.length, 0);
});

// Retention: the hourly job deletes settled requests, offers first, once RETENTION_DAYS have passed.

const day = 24 * hour;
const count = (table: string) => (db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n;
// Moves every request's drop-off to `days` ago.
const age = (days: number) =>
	db.sqlite.prepare("UPDATE requests SET slot_start = ?1, slot_end = ?1 + ?2").run(Date.now() - days * day, quarter);

test("the hourly job deletes settled requests and their offers once they're old enough", async () => {
	both();
	await submit({ slot: iso(slotStart) }); // nobody takes it, so it expires
	await press(await taken({ slot: iso(slotStart + quarter) }), "done");
	mails = [];
	await submit({ slot: iso(slotStart + 2 * quarter) });
	for (const tech of ["richard@example.com", "sam@example.com"]) await press(linkFor(tech), "decline");
	assert.equal(count("requests"), 3);

	age(env.RETENTION_DAYS + 1);
	await tick();
	assert.equal(count("requests"), 0);
	assert.equal(count("offers"), 0);
});

test("the hourly job keeps an old repair that isn't marked done", async () => {
	await taken({});
	age(env.RETENTION_DAYS + 1);
	await tick();
	assert.equal(status(), "confirmed");
	assert.equal(count("offers"), 2);
});

test("the hourly job keeps a settled request until it's old enough", async () => {
	await press(await taken({}), "done");
	age(env.RETENTION_DAYS - 1);
	await tick();
	assert.equal(count("requests"), 1);
	assert.equal(count("offers"), 2);
});

test("answers an unknown queue link with 404", async () => {
	const response = await queueOf("https://intake.test/offers/00000000-0000-4000-8000-000000000000");
	assert.equal(response.status, 404);
});
