import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, dialable, parseIntake, stop } from "./intake.ts";

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
	const parsed = parseIntake(form({}));
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.slot, Date.parse("2026-11-02T15:00:00.000Z"));
	assert.equal(parsed.intake.phone, "416-555-0123");
});

test("needs a time", () => {
	for (const slot of ["", "tomorrow-ish"]) assert.equal(parseIntake(form({ slot })).ok, false, slot);
});

test("collapses whitespace in single-line fields only", () => {
	const parsed = parseIntake(form({ name: "Jane\r\n\tDoe", problem: "Drifts\nand clicks" }));
	assert.ok(parsed.ok);
	assert.equal(parsed.intake.name, "Jane Doe");
	assert.equal(parsed.intake.problem, "Drifts\nand clicks");
});

test("needs an email that looks like an address", () => {
	for (const email of ["", "jane@", "@example.com", "jane doe@example.com"]) {
		assert.equal(parseIntake(form({ email })).ok, false, email);
	}
});

test("needs a phone number with an area code", () => {
	for (const phone of ["4165550123", "(416) 555-0123", "+1 416.555.0123", "+44 20 7946 0958"]) {
		assert.equal(parseIntake(form({ phone })).ok, true, phone);
	}
	for (const phone of ["", "555-0123", "call me", "416-555-0123 x12", "+1 416 555 0123 4567 89"]) {
		assert.equal(parseIntake(form({ phone })).ok, false, phone);
	}
});

test("rejects missing fields", () => {
	assert.equal(parseIntake(form({ problem: "  " })).ok, false);
	assert.equal(parseIntake(form({ device: "" })).ok, false);
});

test("flags the honeypot as spam", () => {
	assert.deepEqual(parseIntake(form({ website: "http://spam" })), { ok: false, spam: true });
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
	assert.doesNotMatch(text, /Phone|Drop-off|house/i);
});

test("ends a sentence on a time with one period", () => {
	assert.equal(stop("Tue, Nov 3, 8:00 a.m."), "Tue, Nov 3, 8:00 a.m.");
	assert.equal(stop("Tue, Nov 3, 08:00"), "Tue, Nov 3, 08:00.");
});
