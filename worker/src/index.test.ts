// The handler end to end, with Google and Fastmail replaced by a fake fetch.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, test } from "node:test";
import { resetTokenCache } from "./google.ts";
import worker from "./index.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const hour = 3_600_000;
const slotStart = Math.ceil((Date.now() + 24 * hour) / hour) * hour;

const env = {
	SITE_URL: "https://repairs.perocho.com",
	MAIL_FROM: "contact@perocho.com",
	MAIL_TO: "contact@perocho.com",
	TIME_ZONE: "America/Toronto",
	WORK_HOURS: "00:00-24:00", // every hour, so the tests don't depend on the time of day
	SLOT_MINUTES: 60,
	LEAD_HOURS: 12,
	DAYS_AHEAD: 14,
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

const iso = (ms: number) => new Date(ms).toISOString();
let calendars: Record<string, object[]>;
let holds: { calendarId: string; body: any }[];
let deleted: { calendarId: string; eventId: string }[];
let mails: any[];
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
	// Richard is busy at the slot; Sam is free. Both are busy the hour after.
	calendars = {
		"richard@example.com": [
			{ summary: "Dentist", start: { dateTime: iso(slotStart) }, end: { dateTime: iso(slotStart + 2 * hour) } },
		],
		"sam@example.com": [
			{ summary: "Gym", start: { dateTime: iso(slotStart + hour) }, end: { dateTime: iso(slotStart + 2 * hour) } },
		],
	};
	holds = [];
	deleted = [];
	mails = [];
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
		if (event && init?.method === "DELETE") {
			const [calendarId, eventId] = [event[1], event[2]].map(decodeURIComponent);
			deleted.push({ calendarId, eventId });
			calendars[calendarId] = calendars[calendarId].filter((e: any) => e.id !== eventId);
			return new Response(null, { status: 204 });
		}
		const calendar = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
		if (calendar) {
			const calendarId = decodeURIComponent(calendar[1]);
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
						["Identity/get", { list: [{ id: "id1", name: "Perocho Repairs", email: "contact@perocho.com" }] }, "identities"],
						["Mailbox/query", { ids: ["drafts"] }, "drafts"],
						["Mailbox/query", { ids: ["sent"] }, "sent"],
					],
				});
			}
			mails.push(body.methodCalls[0][1].create.draft);
			return Response.json({
				methodResponses: [
					["Email/set", { created: { draft: { id: "e1" } } }, "email"],
					["EmailSubmission/set", { created: { send: { id: "s1" } } }, "submission"],
				],
			});
		}
		throw new Error(`unexpected fetch ${url}`);
	};
});

const submit = (fields: Record<string, string>, headers: Record<string, string> = {}) => {
	const body = new URLSearchParams({
		name: "Jane",
		contact: "email",
		email: "jane@example.com",
		service: "PS5 deep cleaning",
		device: "PS5 disc",
		problem: "Loud fan",
		visit: "drop-off",
		...fields,
	});
	return worker.fetch(new Request("https://intake.test/request", { method: "POST", body, headers }), env);
};

test("lists only times when some tech is free", async () => {
	const response = await worker.fetch(new Request("https://intake.test/slots"), env);
	const { timeZone, slots } = (await response.json()) as { timeZone: string; slots: { start: string }[] };
	assert.equal(timeZone, env.TIME_ZONE);
	const starts = slots.map((s) => s.start);
	assert.ok(starts.includes(iso(slotStart)));
	assert.ok(!starts.includes(iso(slotStart + hour)));
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), env.SITE_URL);
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

test("holds the picked time on the free tech's calendar and emails the techs", async () => {
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");

	assert.equal(holds.length, 1);
	assert.equal(holds[0].calendarId, "sam@example.com");
	assert.equal(holds[0].body.status, "tentative");
	assert.equal(holds[0].body.summary, "Request: PS5 deep cleaning (Jane)");

	assert.equal(mails.length, 1);
	assert.deepEqual(mails[0].replyTo, [{ email: "jane@example.com" }]);
	assert.match(mails[0].bodyValues.body.value, /Held on: Sam's calendar \(tentative\)/);
});

test("sends a request without a time as email only", async () => {
	const response = await submit({});
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(holds.length, 0);
	assert.match(mails[0].bodyValues.body.value, /None picked/);
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
});

test("keeps its hold when it beat a racing request", async () => {
	rival = (ours) => racingHold("rival", Date.parse(ours.created) + 1000);
	const response = await submit({ slot: iso(slotStart) });
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/sent/");
	assert.equal(deleted.length, 0);
	assert.equal(mails.length, 1);
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
	assert.equal(errors.length, 1);
});

test("sends people to the failure page when a service is down", async () => {
	globalThis.fetch = async () => new Response("down", { status: 503 });
	const original = console.error;
	console.error = () => {};
	const response = await submit({});
	console.error = original;
	assert.equal(response.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
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
	assert.equal(mails.length, 1);
	assert.deepEqual(limitKeys, ["203.0.113.7"]);

	const second = await quietly(() => submit({}, { "CF-Connecting-IP": "203.0.113.7" }));
	assert.equal(second.headers.get("Location"), "https://repairs.perocho.com/request/failed/");
	assert.equal(mails.length, 1);
});

test("shares one count between posts without a visitor IP", async () => {
	await submit({});
	assert.deepEqual(limitKeys, ["unknown"]);
});

test("doesn't count honeypot or invalid posts", async () => {
	await submit({ website: "spam" });
	await submit({ name: "" });
	assert.deepEqual(limitKeys, []);
});
