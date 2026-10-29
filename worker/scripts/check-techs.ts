// Checks the TECHS list against Google and, with --send, Fastmail, the way the worker will use it.
// Changes nothing unless --send is given, and then only sends one test email to each tech.
//
//   npm run check-techs                      # TECHS from techs.json, the key from .dev.vars or the env
//   npm run check-techs -- --techs other.json --key service-account.json
//   npm run check-techs -- --send            # also email each tech (needs FASTMAIL_TOKEN)
//
// Secrets come from the environment first, then .dev.vars: TECHS (or --techs, default techs.json),
// GOOGLE_SERVICE_ACCOUNT (or --key) and, for --send, FASTMAIL_TOKEN. Exits 1 if anything failed.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sendMail } from "../src/fastmail.ts";
import { accessToken, listEvents } from "../src/google.ts";
import { parseTechs, type Tech } from "../src/index.ts";
import { openSlots } from "../src/slots.ts";

const { values: args } = parseArgs({
	options: {
		techs: { type: "string" },
		key: { type: "string" },
		send: { type: "boolean", default: false },
	},
});

if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars");

// The same settings the deployed worker uses. wrangler.jsonc only has whole-line comments.
const vars = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")).vars as {
	MAIL_FROM: string;
	SLOT_MINUTES: number;
	LEAD_HOURS: number;
	DAYS_AHEAD: number;
};

let failed = false;
const ok = (message: string) => console.log(`  ok    ${message}`);
const warn = (message: string) => console.log(`  warn  ${message}`);
const fail = (message: string) => {
	failed = true;
	console.log(`  FAIL  ${message}`);
};

// Loose on purpose: catches typos and calendar IDs used as addresses, not every invalid address.
const looksLikeEmail = (address: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
const emailOf = (tech: Tech) => tech.email ?? tech.calendarId;

function readTechs(): Tech[] | null {
	const raw = process.env.TECHS ?? readFileSync(args.techs ?? "techs.json", "utf8");
	try {
		return parseTechs(raw);
	} catch (error) {
		fail((error as Error).message);
		return null;
	}
}

function checkList(techs: Tech[]) {
	console.log(`TECHS: ${techs.length} tech${techs.length === 1 ? "" : "s"}`);
	const repeated = (values: string[]) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
	for (const name of repeated(techs.map((t) => t.name.trim().toLowerCase()))) fail(`"${name}" is listed more than once`);
	for (const id of repeated(techs.map((t) => t.calendarId.toLowerCase()))) fail(`calendar ${id} is listed more than once`);
	for (const email of repeated(techs.map((t) => emailOf(t).toLowerCase()))) warn(`${email} gets more than one tech's requests`);
	for (const tech of techs) {
		if (!tech.name.trim()) fail(`a tech with calendar ${tech.calendarId} has no name`);
		const email = emailOf(tech);
		if (/calendar\.google\.com$/i.test(email)) {
			fail(`${tech.name}: requests would go to the calendar ID ${email}, which can't get mail; add an "email"`);
		} else if (!looksLikeEmail(email)) {
			fail(`${tech.name}: "${email}" doesn't look like an email address`);
		}
	}
}

// The worker reads events and writes holds, so the service account needs "Make changes to events".
async function checkCalendar(token: string, tech: Tech, now: number) {
	console.log(`${tech.name} (calendar ${tech.calendarId}, requests to ${emailOf(tech)})`);
	const query = new URLSearchParams({ maxResults: "1", fields: "accessRole" });
	const response = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(tech.calendarId)}/events?${query}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (response.status === 404) {
		fail("calendar not found: the ID is wrong, or it isn't shared with the service account");
		return;
	}
	if (!response.ok) {
		fail(`can't read the calendar: ${response.status} ${await response.text()}`);
		return;
	}
	const { accessRole } = (await response.json()) as { accessRole?: string };
	if (accessRole === "writer" || accessRole === "owner") ok(`shared with "Make changes to events" (${accessRole})`);
	else fail(`shared as "${accessRole}"; it needs "Make changes to events" to hold times`);

	const to = now + vars.DAYS_AHEAD * 86_400_000;
	const events = await listEvents(token, tech.calendarId, now, to);
	const blocks = events.filter((event) => event.available && !event.allDay && !event.declined).length;
	const slots = openSlots([events], {
		now,
		slotMinutes: vars.SLOT_MINUTES,
		leadHours: vars.LEAD_HOURS,
		daysAhead: vars.DAYS_AHEAD,
	}).length;
	const window = `in the next ${vars.DAYS_AHEAD} days`;
	if (blocks === 0) warn(`no timed "Available..." blocks ${window}, so they won't be offered any times`);
	else if (slots === 0) warn(`${blocks} "Available..." block${blocks === 1 ? "" : "s"} ${window}, but every time in them is taken or too soon`);
	else ok(`${blocks} "Available..." block${blocks === 1 ? "" : "s"}, ${slots} open time${slots === 1 ? "" : "s"} ${window}`);
}

async function sendTests(techs: Tech[]) {
	console.log(`Test emails from ${vars.MAIL_FROM}`);
	const token = process.env.FASTMAIL_TOKEN;
	if (!token) {
		fail("FASTMAIL_TOKEN isn't set");
		return;
	}
	// One at a time, so a bad address fails only its own email.
	for (const tech of techs) {
		try {
			await sendMail(token, [
				{
					from: vars.MAIL_FROM,
					to: emailOf(tech),
					subject: "Test: repair requests will come to this address",
					text: `Hi ${tech.name},\n\nThis is a test from the repair request form's setup check. Repair requests will be emailed to this address. Nothing to do; you can delete this.\n`,
				},
			]);
			ok(`sent to ${tech.name} at ${emailOf(tech)}; check that it arrived`);
		} catch (error) {
			fail(`${tech.name} at ${emailOf(tech)}: ${(error as Error).message}`);
		}
	}
}

const techs = readTechs();
if (techs) {
	checkList(techs);

	const keyJson = args.key ? readFileSync(args.key, "utf8") : process.env.GOOGLE_SERVICE_ACCOUNT;
	if (!keyJson) {
		fail("GOOGLE_SERVICE_ACCOUNT isn't set; pass --key <file> or put it in .dev.vars");
	} else {
		let token: string | null = null;
		try {
			const account = JSON.parse(keyJson) as { client_email?: string };
			token = await accessToken(keyJson);
			console.log(`Google: signed in as ${account.client_email}; share each calendar with this address`);
		} catch (error) {
			fail(`can't sign in to Google with the service account key: ${(error as Error).message}`);
		}
		if (token) {
			const now = Date.now();
			for (const tech of techs) {
				await checkCalendar(token, tech, now).catch((error: Error) => fail(error.message));
			}
		}
	}

	if (args.send) await sendTests(techs);
}

console.log(failed ? "\nSome checks failed." : "\nAll checks passed.");
process.exitCode = failed ? 1 : 0;
