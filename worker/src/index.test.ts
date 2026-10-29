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
const slotStart = Math.ceil((Date.now() + 24 * hour) / hour) * hour;

const env = {
	SITE_URL: "https://repairs.perocho.com",
	MAIL_FROM: "repairs@perocho.com",
	MAIL_TO: "repairs@perocho.com",
	TIME_ZONE: "America/Toronto",
	SLOT_MINUTES: 60,
	LEAD_HOURS: 2,
	DAYS_AHEAD: 31,
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
// Another request's hold that lands on the same calendar right after ours is written, unseen by
// our first look at the calendar: the race the re-check is for.
let rival: ((ours: { id: string; created: string }) => object) | null;
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
	rival = null;
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
				const ours = { id: `hold${holds.length}`, created: new Date().toISOString() };
				calendars[calendarId].push({ ...body, ...ours });
				if (rival) calendars[calendarId].push(rival(ours));
				return Response.json(ours);
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

test("sends people back when the time was just taken", async () => {
	calendars["sam@example.com"].push({
		summary: "Request: TMR sticks (Alex)",
		start: { dateTime: iso(slotStart) },
		end: { dateTime: iso(slotStart + hour) },
	});
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/taken/");
	assert.equal(holds.length + mails.length, 0);
});

const racingHold = (id: string, created: number) => ({
	id,
	created: iso(created),
	summary: "Request: TMR sticks (Alex)",
	start: { dateTime: iso(slotStart) },
	end: { dateTime: iso(slotStart + hour) },
});

test("gives up its hold when a racing request held the slot first", async () => {
	rival = (ours) => racingHold("rival", Date.parse(ours.created) - 1000);
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/taken/");
	assert.deepEqual(deleted, [{ calendarId: "sam@example.com", eventId: "hold1" }]);
	assert.deepEqual(calendars["sam@example.com"].map((e: any) => e.id).filter(Boolean), ["rival"]);
	assert.equal(mails.length, 0);
	assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM requests").get()!.n, 0);
});

test("keeps its hold when it beat a racing request", async () => {
	rival = (ours) => racingHold("rival", Date.parse(ours.created) + 1000);
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(deleted.length, 0);
	assert.equal(mails.length, 4);
});

test("breaks a tie between racing holds by id, so both sides agree", async () => {
	rival = (ours) => racingHold("a-rival", Date.parse(ours.created)); // "a-rival" < "hold1"
	const lost = await submit({ slot: iso(slotStart) });
	assert.equal(lost.headers.get("Location"), "https://repairs.perocho.com/request/taken/");

	calendars["sam@example.com"] = calendars["sam@example.com"].filter((e: any) => e.id !== "a-rival");
	rival = (ours) => racingHold("z-rival", Date.parse(ours.created)); // "z-rival" > "hold2"
	const won = await submit({ slot: iso(slotStart) });
	assert.equal(won.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
});

test("drops honeypot submissions quietly", async () => {
	const response = await submit({ website: "spam" });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(mails.length, 0);
});

const getSlots = () => worker.fetch(new Request("https://intake.test/slots"), env);

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
	// Its hold gone (declined, say), so the time is free again.
	calendars["sam@example.com"] = calendars["sam@example.com"].filter((e: any) => !e.id);
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
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/taken/");
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
	assert.deepEqual(deleted, [{ calendarId: "sam@example.com", eventId: "hold1" }]);
});

// A request filed before times and phones were required: no slot, no phone, and a `visit`.
const legacy = () => {
	const intake = { name: "Jane", email: "jane@example.com", service: "", device: "PS5", problem: "Loud fan", visit: "house-call", slot: null, notes: "" };
	db.sqlite.prepare("INSERT INTO requests (id, created, intake) VALUES ('old', ?, ?)").run(Date.now(), JSON.stringify(intake));
	const token = "00000000-0000-4000-8000-000000000001";
	db.sqlite
		.prepare("INSERT INTO offers (token, request_id, position, name, email, calendar_id) VALUES (?, 'old', 0, 'Sam', 'sam@example.com', 'sam@example.com')")
		.run(token);
	return `https://intake.test/offers/${token}`;
};

test("shows and takes a request from before times were required, touching no calendar", async () => {
	const sam = legacy();
	const body = await (await offerPage(sam)).text();
	assert.match(body, /New repair request/);
	assert.ok(!body.includes("tel:") && !/house/i.test(body));
	await press(sam, "confirm");
	assert.equal(status(), "confirmed");
	assert.equal(holds.length + patched.length + deleted.length, 0);
	assert.match(text(to("jane@example.com")[0]), /will be in touch to find a time/);
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

test("a tech can't take two repairs at the same time", async () => {
	both();
	await submit({ slot: iso(slotStart) });
	await press(linkFor("sam@example.com"), "confirm");

	// Richard's hold went, so he's free for Bob's request at the same time; Sam has Jane's repair.
	mails = [];
	await submit({ slot: iso(slotStart), name: "Bob", email: "bob@example.com" });
	const bob = () => db.sqlite.prepare("SELECT status FROM requests WHERE intake LIKE '%Bob%'").get() as any;
	const [richard, sam] = [linkFor("richard@example.com"), linkFor("sam@example.com")];
	mails = [];
	await press(sam, "confirm");
	assert.equal(bob().status, "pending");
	assert.equal(mails.length, 0);
	const body = await (await offerPage(sam)).text();
	assert.match(body, /You already have a repair then/);
	assert.ok(!body.includes('value="confirm">'));

	await press(richard, "confirm");
	assert.equal(bob().status, "confirmed");
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

test("expires a request from before times were required after a week", async () => {
	legacy();
	db.sqlite.prepare("UPDATE requests SET created = ?").run(Date.now() - 6 * 24 * hour);
	await tick();
	assert.equal(status(), "pending");
	db.sqlite.prepare("UPDATE requests SET created = ?").run(Date.now() - 8 * 24 * hour);
	await tick();
	assert.equal(status(), "expired");
	assert.match(text(to("jane@example.com").at(-1)), /none of our techs could take this one/);
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
