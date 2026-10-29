import assert from "node:assert/strict";
import { test } from "node:test";
import { type CalendarEvent, isAvailable, openSlots } from "./slots.ts";

// Monday 2 November 2026, Toronto (EST, -05:00).
const at = (time: string, date = "2026-11-02") => Date.parse(`${date}T${time}:00-05:00`);
const now = at("00:00");
const options = {
	now,
	slotMinutes: 60,
	leadHours: 2,
	daysAhead: 1,
};

const event = (start: string, end: string, extra: Partial<CalendarEvent> = {}) => ({
	start: at(start),
	end: at(end),
	allDay: false,
	transparent: false,
	declined: false,
	available: false,
	...extra,
});
const available = (start: string, end: string, extra: Partial<CalendarEvent> = {}) =>
	event(start, end, { available: true, ...extra });

const starts = (eventsByTech: CalendarEvent[][], extra: Partial<typeof options> = {}) =>
	openSlots(eventsByTech, { ...options, ...extra }).map((slot) => [new Date(slot.start).toISOString(), slot.techs]);

test("offers nothing without an Available block", () => {
	assert.deepEqual(starts([[]]), []);
	assert.deepEqual(starts([[event("09:00", "12:00") /* Shift */]]), []);
});

test("splits an Available block into slots from its start", () => {
	assert.deepEqual(starts([[available("09:30", "12:00")]]), [
		["2026-11-02T14:30:00.000Z", [0]],
		["2026-11-02T15:30:00.000Z", [0]],
	]);
});

test("recognises Available blocks by title", () => {
	assert.ok(isAvailable("Available"));
	assert.ok(isAvailable("  available - shop"));
	assert.ok(!isAvailable("Not available"));
	assert.ok(!isAvailable(""));
});

test("the blocks themselves don't block, even when shown as busy", () => {
	const blockTwice = [available("09:00", "11:00"), available("10:00", "12:00")];
	assert.deepEqual(starts([blockTwice]).map(([start]) => start), [
		"2026-11-02T14:00:00.000Z",
		"2026-11-02T15:00:00.000Z",
		"2026-11-02T16:00:00.000Z",
	]);
});

test("all-day and declined Available blocks don't offer anything", () => {
	const events = [available("00:00", "23:59", { allDay: true }), available("09:00", "12:00", { declined: true })];
	assert.deepEqual(starts([events]), []);
});

test("events inside a block take out the slots they overlap", () => {
	assert.deepEqual(starts([[available("09:00", "12:00"), event("10:30", "11:00") /* Dentist */]]), [
		["2026-11-02T14:00:00.000Z", [0]],
		["2026-11-02T16:00:00.000Z", [0]],
	]);
});

test("free, all-day and declined events don't block", () => {
	const events = [
		available("09:00", "12:00"),
		event("09:00", "12:00", { transparent: true }), // Reminder
		event("00:00", "23:59", { allDay: true }), // Birthday
		event("09:00", "12:00", { declined: true }), // Meeting
	];
	assert.equal(starts([events]).length, 3);
});

test("a request hold blocks the slot for that tech only", () => {
	const richard = [available("09:00", "12:00"), event("09:00", "12:00") /* Request: cleaning */];
	const sam = [available("09:00", "12:00")];
	assert.deepEqual(starts([richard, sam]).map(([, techs]) => techs), [[1], [1], [1]]);
});

test("each tech is only offered inside their own blocks", () => {
	assert.deepEqual(starts([[available("09:00", "10:00")], [available("11:00", "12:00")]]), [
		["2026-11-02T14:00:00.000Z", [0]],
		["2026-11-02T16:00:00.000Z", [1]],
	]);
});

test("merges techs who are free at the same time, each once, in list order", () => {
	const block = [available("09:00", "11:00"), available("09:00", "10:00")];
	for (const slot of openSlots([block, block, block], options)) assert.deepEqual(slot.techs, [0, 1, 2]);
});

test("respects the notice period and the horizon", () => {
	assert.deepEqual(starts([[available("09:00", "12:00")]], { leadHours: 11 }), [["2026-11-02T16:00:00.000Z", [0]]]);
	const late = { ...available("09:00", "10:00"), start: at("09:00", "2026-11-03"), end: at("10:00", "2026-11-03") };
	assert.deepEqual(starts([[late]]), []);
	assert.equal(starts([[late]], { daysAhead: 2 }).length, 1);
});
