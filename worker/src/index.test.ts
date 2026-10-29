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
};

const iso = (ms: number) => new Date(ms).toISOString();
let calendars: Record<string, object[]>;
let holds: { calendarId: string; body: any }[];
let mails: any[];
let tokenRequests: number;
let tokenLifetime: number; // seconds, as Google's expires_in

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
	mails = [];
	tokenRequests = 0;
	tokenLifetime = 3600;
	resetTokenCache();

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
		if (url.href === "https://oauth2.googleapis.com/token") {
			tokenRequests++;
			return Response.json({ access_token: "google-token", expires_in: tokenLifetime });
		}
		const calendar = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
		if (calendar) {
			const calendarId = decodeURIComponent(calendar[1]);
			if (init?.method === "POST") {
				holds.push({ calendarId, body });
				return Response.json({});
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

const submit = (fields: Record<string, string>) => {
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
	return worker.fetch(new Request("https://intake.test/request", { method: "POST", body }), env);
};

test("lists only times when some tech is free", async () => {
	const response = await worker.fetch(new Request("https://intake.test/slots"), env);
	const { slots } = (await response.json()) as { slots: { start: string }[] };
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
