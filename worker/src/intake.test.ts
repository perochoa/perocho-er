import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntake, replyTo } from "./intake.ts";

const form = (fields: Record<string, string>) => {
	const data = new FormData();
	const base = {
		name: "Jane",
		contact: "email",
		email: "jane@example.com",
		device: "DualSense",
		problem: "Left stick drifts",
		visit: "drop-off",
	};
	for (const [key, value] of Object.entries({ ...base, ...fields })) data.set(key, value);
	return data;
};

test("accepts a complete request without a time", () => {
	const parsed = parseIntake(form({}));
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.slot, null);
});

test("parses the picked time", () => {
	const parsed = parseIntake(form({ slot: "2026-11-02T15:00:00.000Z" }));
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.slot, Date.parse("2026-11-02T15:00:00.000Z"));
});

test("collapses whitespace in single-line fields only", () => {
	const parsed = parseIntake(form({ name: "Jane\r\n\tDoe", problem: "Drifts\nand clicks" }));
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.name, "Jane Doe");
	assert.equal(parsed.intake.problem, "Drifts\nand clicks");
});

test("needs the detail for the chosen way to reach them", () => {
	assert.equal(parseIntake(form({ contact: "email", email: "nope" })).ok, false);
	assert.equal(parseIntake(form({ contact: "text", phone: "555-1234" })).ok, false);
	assert.ok(parseIntake(form({ contact: "text", phone: "(905) 555-1234" })).ok);
	assert.equal(parseIntake(form({ contact: "messenger" })).ok, false);
	assert.ok(parseIntake(form({ contact: "messenger", facebook: "Jane Doe" })).ok);
});

test("rejects missing fields and unknown choices", () => {
	assert.equal(parseIntake(form({ problem: "  " })).ok, false);
	assert.equal(parseIntake(form({ contact: "pigeon" })).ok, false);
	assert.equal(parseIntake(form({ visit: "mail-in" })).ok, false);
	assert.equal(parseIntake(form({ slot: "tomorrow-ish" })).ok, false);
});

test("flags the honeypot as spam", () => {
	assert.deepEqual(parseIntake(form({ website: "http://spam" })), { ok: false, spam: true });
});

test("replies to the email only when it looks like an address", () => {
	const reply = (fields: Record<string, string>) => {
		const parsed = parseIntake(form(fields));
		assert.ok(parsed.ok);
		return replyTo(parsed.intake);
	};
	assert.equal(reply({}), "jane@example.com");
	// Optional when they'd rather get a text, so a typo there doesn't refuse the request.
	const text = { contact: "text", phone: "(905) 555-1234" };
	assert.equal(reply({ ...text, email: "jane@example.com" }), "jane@example.com");
	assert.equal(reply({ ...text, email: "jane@" }), undefined);
	assert.equal(reply({ ...text, email: "@example.com" }), undefined);
	assert.equal(reply({ ...text, email: "jane doe@example.com" }), undefined);
	assert.equal(reply({ ...text, email: "" }), undefined);
});
