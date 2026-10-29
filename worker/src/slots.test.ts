import assert from "node:assert/strict";
import { test } from "node:test";
import { type CalendarEvent, openSlots } from "./slots.ts";

const at = (time: string) => Date.parse(`2026-11-02T${time}:00-05:00`);
const now = at("00:00");
const options = { now, slotMinutes: 60, leadHours: 2, daysAhead: 14 };

const event = (summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}) => ({
	summary,
	start: at(start),
	end: at(end),
	allDay: false,
	transparent: false,
	declined: false,
	...extra,
});

const starts = (eventsByTech: CalendarEvent[][]) =>
	openSlots(eventsByTech, options).map((slot) => [new Date(slot.start).toISOString(), slot.techs]);

test("splits an available block into whole slots", () => {
	assert.deepEqual(starts([[event("Available", "10:00", "12:30")]]), [
		["2026-11-02T15:00:00.000Z", [0]],
		["2026-11-02T16:00:00.000Z", [0]],
	]);
});

test("other events on the same calendar block overlapping slots", () => {
	const events = [event("Available", "10:00", "13:00"), event("Dentist", "11:30", "12:00")];
	assert.deepEqual(starts([events]), [
		["2026-11-02T15:00:00.000Z", [0]],
		["2026-11-02T17:00:00.000Z", [0]],
	]);
});

test("free, all-day and declined events don't block", () => {
	const events = [
		event("Available", "10:00", "11:00"),
		event("Reminder", "10:00", "11:00", { transparent: true }),
		event("Birthday", "00:00", "23:59", { allDay: true }),
		event("Meeting", "10:00", "11:00", { declined: true }),
	];
	assert.equal(starts([events]).length, 1);
});

test("a request hold blocks the slot for that tech only", () => {
	const richard = [event("Available", "10:00", "11:00"), event("Request: cleaning", "10:00", "11:00")];
	const sam = [event("available (evening)", "10:00", "11:00")];
	assert.deepEqual(starts([richard, sam]), [["2026-11-02T15:00:00.000Z", [1]]]);
});

test("merges techs who are free at the same time", () => {
	const both = [event("Available", "10:00", "11:00")];
	assert.deepEqual(starts([both, both]), [["2026-11-02T15:00:00.000Z", [0, 1]]]);
});

test("respects the notice period and the horizon", () => {
	const early = event("Available", "01:00", "03:00");
	const late = { ...event("Available", "10:00", "11:00"), start: now + 15 * 86_400_000 };
	late.end = late.start + 3_600_000;
	assert.deepEqual(starts([[early, late]]), [["2026-11-02T07:00:00.000Z", [0]]]);
});

test("ignores titles that only contain the word", () => {
	assert.deepEqual(starts([[event("Not available", "10:00", "11:00")]]), []);
});
