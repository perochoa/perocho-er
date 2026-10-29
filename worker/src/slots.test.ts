import assert from "node:assert/strict";
import { test } from "node:test";
import { type CalendarEvent, openSlots, parseWorkHours } from "./slots.ts";

// Monday 2 November 2026, Toronto (EST, -05:00).
const at = (time: string, date = "2026-11-02") => Date.parse(`${date}T${time}:00-05:00`);
const now = at("00:00");
const options = {
	now,
	slotMinutes: 60,
	leadHours: 2,
	daysAhead: 1,
	workHours: parseWorkHours("09:00-12:00"),
	timeZone: "America/Toronto",
};

const event = (summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}) => ({
	summary,
	start: at(start),
	end: at(end),
	allDay: false,
	transparent: false,
	declined: false,
	...extra,
});

const starts = (eventsByTech: CalendarEvent[][], extra: Partial<typeof options> = {}) =>
	openSlots(eventsByTech, { ...options, ...extra }).map((slot) => [new Date(slot.start).toISOString(), slot.techs]);

test("offers every working hour of every day when the calendar is empty", () => {
	assert.deepEqual(starts([[]]), [
		["2026-11-02T14:00:00.000Z", [0]],
		["2026-11-02T15:00:00.000Z", [0]],
		["2026-11-02T16:00:00.000Z", [0]],
	]);
});

test("includes weekends", () => {
	const saturday = Date.parse("2026-11-07T00:00:00-05:00");
	assert.equal(starts([[]], { now: saturday }).length, 3);
});

test("events block overlapping slots", () => {
	assert.deepEqual(starts([[event("Dentist", "10:30", "11:00")]]), [
		["2026-11-02T14:00:00.000Z", [0]],
		["2026-11-02T16:00:00.000Z", [0]],
	]);
});

test("free, all-day and declined events don't block", () => {
	const events = [
		event("Reminder", "09:00", "12:00", { transparent: true }),
		event("Birthday", "00:00", "23:59", { allDay: true }),
		event("Meeting", "09:00", "12:00", { declined: true }),
	];
	assert.equal(starts([events]).length, 3);
});

test("a request hold blocks the slot for that tech only", () => {
	const richard = [event("Request: cleaning", "09:00", "12:00")];
	assert.deepEqual(starts([richard, []]).map(([, techs]) => techs), [[1], [1], [1]]);
});

test("merges techs who are free at the same time", () => {
	assert.deepEqual(starts([[], []])[0][1], [0, 1]);
});

test("respects the notice period and the horizon", () => {
	assert.deepEqual(starts([[]], { leadHours: 11, workHours: parseWorkHours("09:00-12:00") }), [
		["2026-11-02T16:00:00.000Z", [0]],
	]);
	const days = new Set(starts([[]], { daysAhead: 3 }).map(([start]) => String(start).slice(0, 10)));
	assert.deepEqual([...days], ["2026-11-02", "2026-11-03", "2026-11-04"]);
});

test("keeps local hours across a daylight saving change", () => {
	// Clocks went back on Sunday 1 November 2026: 9:00 is 13:00Z on Saturday, 14:00Z on Sunday.
	const saturday = Date.parse("2026-10-31T00:00:00-04:00");
	const firsts = starts([[]], { now: saturday, daysAhead: 2, workHours: parseWorkHours("09:00-10:00") });
	assert.deepEqual(firsts.map(([start]) => start), ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
});

test("rejects malformed working hours", () => {
	assert.throws(() => parseWorkHours("9-5"));
});

test("lists each free tech once, in list order", () => {
	// Hours past midnight overlap the next day's, so a tech reaches some starts twice.
	for (const hours of ["09:00-17:00", "09:00-34:00"]) {
		const slots = openSlots([[], [], []], { ...options, leadHours: 0, daysAhead: 2, workHours: parseWorkHours(hours) });
		for (const slot of slots) assert.deepEqual(slot.techs, [0, 1, 2]);
	}
});
