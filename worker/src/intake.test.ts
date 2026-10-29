import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntake } from "./intake.ts";

const form = (fields: Record<string, string>) => {
	const data = new FormData();
	const base = {
		name: "Jane",
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

test("needs an email that looks like an address", () => {
	for (const email of ["", "jane@", "@example.com", "jane doe@example.com"]) {
		assert.equal(parseIntake(form({ email })).ok, false, email);
	}
});

test("rejects missing fields and unknown choices", () => {
	assert.equal(parseIntake(form({ problem: "  " })).ok, false);
	assert.equal(parseIntake(form({ visit: "mail-in" })).ok, false);
	assert.equal(parseIntake(form({ slot: "tomorrow-ish" })).ok, false);
});

test("flags the honeypot as spam", () => {
	assert.deepEqual(parseIntake(form({ website: "http://spam" })), { ok: false, spam: true });
});
