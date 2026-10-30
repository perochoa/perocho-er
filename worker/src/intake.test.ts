import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, dialable, parseIntake, rushed, stop } from "./intake.ts";

const form = (fields: Record<string, string>) => {
	const data = new FormData();
	const base = {
		name: "Jane",
		email: "jane@example.com",
		phone: "416-555-0123",
		device: "DualSense",
		problem: "Left stick drifts",
		slot: "2026-11-02T15:00:00.000Z",
	};
	for (const [key, value] of Object.entries({ ...base, ...fields })) data.set(key, value);
	return data;
};

test("parses the picked time and the phone as typed", () => {
	const parsed = parseIntake(form({}), 20);
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.slot, Date.parse("2026-11-02T15:00:00.000Z"));
	assert.equal(parsed.intake.phone, "416-555-0123");
});

test("takes a rush only from the checkbox, as the fee it was offered at", () => {
	const rush = (fields: Record<string, string>) => {
		const parsed = parseIntake(form(fields), 20);
		assert.ok(parsed.ok);
		return parsed.intake.rush;
	};
	assert.equal(rush({ rush: "1" }), 20);
	assert.equal(rush({}), 0);
	assert.equal(rush({ rush: "yes" }), 0);
});

test("shows a rush in the summary, and nothing when there isn't one", () => {
	const parsed = parseIntake(form({ rush: "1" }), 20);
	assert.ok(parsed.ok);
	assert.match(describe(parsed.intake, "Mon, Nov 2, 10:00 a.m."), /\nRush: yes, \+\$20 \(paid in person\)\n/);
	assert.equal(rushed(parsed.intake), "RUSH DualSense");
	const plain = parseIntake(form({}), 20);
	assert.ok(plain.ok);
	assert.doesNotMatch(describe(plain.intake, "Mon, Nov 2, 10:00 a.m."), /Rush/);
	assert.equal(rushed(plain.intake), "DualSense");
});

test("needs a time", () => {
	for (const slot of ["", "tomorrow-ish"]) assert.equal(parseIntake(form({ slot }), 20).ok, false, slot);
});

test("collapses whitespace in single-line fields only", () => {
	const parsed = parseIntake(form({ name: "Jane\r\n\tDoe", problem: "Drifts\nand clicks" }), 20);
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.name, "Jane Doe");
	assert.equal(parsed.intake.problem, "Drifts\nand clicks");
});

test("needs an email that looks like an address", () => {
	for (const email of ["", "jane@", "@example.com", "jane doe@example.com"]) {
		assert.equal(parseIntake(form({ email }), 20).ok, false, email);
	}
});

test("needs a phone number with an area code", () => {
	for (const phone of ["4165550123", "(416) 555-0123", "+1 416.555.0123", "+44 20 7946 0958"]) {
		assert.equal(parseIntake(form({ phone }), 20).ok, true, phone);
	}
	for (const phone of ["", "555-0123", "call me", "416-555-0123 x12", "+1 416 555 0123 4567 89"]) {
		assert.equal(parseIntake(form({ phone }), 20).ok, false, phone);
	}
});

test("rejects missing fields", () => {
	assert.equal(parseIntake(form({ problem: "  " }), 20).ok, false);
	assert.equal(parseIntake(form({ device: "" }), 20).ok, false);
});

test("flags the honeypot as spam", () => {
	assert.deepEqual(parseIntake(form({ website: "http://spam" }), 20), { ok: false, spam: true });
});

test("dials the digits, keeping a leading +", () => {
	assert.equal(dialable("(416) 555-0123"), "4165550123");
	assert.equal(dialable(" +1 416.555.0123"), "+14165550123");
});

test("summarizes a request from before phones and times were required", () => {
	// An old row: a `visit` nothing reads now, no phone and no time.
	const old = JSON.parse('{"name":"Jane","email":"jane@example.com","service":"","device":"PS5","problem":"Loud","visit":"house-call","slot":null,"notes":""}');
	const text = describe(old, null);
	assert.match(text, /^Name: Jane\nEmail: jane@example\.com\nDevice: PS5\n/);
	assert.doesNotMatch(text, /Phone|Drop-off|house|Rush/i);
});

test("ends a sentence on a time with one period", () => {
	assert.equal(stop("Tue, Nov 3, 8:00 a.m."), "Tue, Nov 3, 8:00 a.m.");
	assert.equal(stop("Tue, Nov 3, 08:00"), "Tue, Nov 3, 08:00.");
});
