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

test("splits an Available block into whole steps, from the first one inside it", () => {
	assert.deepEqual(starts([[available("09:30", "12:00")]]), [
		["2026-11-02T15:00:00.000Z", [0]],
		["2026-11-02T16:00:00.000Z", [0]],
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

test("the worker's holds and bookings are free, so any number of drop-offs share a time", () => {
	const richard = [
		available("09:00", "10:00"),
		event("09:00", "09:15", { transparent: true }), // Request: cleaning
		event("09:00", "09:15", { transparent: true }), // Repair: stick drift
	];
	assert.deepEqual(starts([richard], { slotMinutes: 15 }).map(([, techs]) => techs), [[0], [0], [0], [0]]);
});

test("an hour-long hold from before drop-offs still blocks, for that tech only", () => {
	const richard = [available("09:00", "12:00"), event("09:00", "12:00") /* Request: cleaning */];
	const sam = [available("09:00", "12:00")];
	assert.deepEqual(starts([richard, sam]).map(([, techs]) => techs), [[1], [1], [1]]);
});

const quarters = (eventsByTech: CalendarEvent[][]) =>
	openSlots(eventsByTech, { ...options, slotMinutes: 15 }).map((slot) => [
		new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(slot.start),
		slot.techs,
	]);

test("an offset block's times are on the quarter hour, inside the block", () => {
	assert.deepEqual(quarters([[available("13:05", "14:00")]]), [
		["13:15", [0]],
		["13:30", [0]],
		["13:45", [0]],
	]);
	// Only the start is rounded: 13:45 would run past a block that ends at 13:55.
	assert.deepEqual(quarters([[available("13:00", "13:55")]]).map(([time]) => time), ["13:00", "13:15", "13:30"]);
});

test("techs with offset blocks share the quarter hours", () => {
	assert.deepEqual(quarters([[available("13:05", "14:00")], [available("13:10", "13:50")]]), [
		["13:15", [0, 1]],
		["13:30", [0, 1]],
		["13:45", [0]],
	]);
});

test("a block shorter than a step once rounded offers nothing", () => {
	assert.deepEqual(quarters([[available("13:05", "13:25")]]), []);
	assert.deepEqual(quarters([[available("13:01", "13:15")]]), []);
});

test("an event inside a block takes out the quarter hours it overlaps", () => {
	assert.deepEqual(quarters([[available("09:10", "10:00"), event("09:30", "09:40") /* Call */]]).map(([time]) => time), ["09:15", "09:45"]);
});

test("other step lengths stay on the hour too", () => {
	assert.deepEqual(starts([[available("09:10", "11:00")]], { slotMinutes: 30 }).map(([start]) => start), [
		"2026-11-02T14:30:00.000Z",
		"2026-11-02T15:00:00.000Z",
		"2026-11-02T15:30:00.000Z",
	]);
	// Another whole-hour offset (+03:00) gets the same quarter hours.
	const block = { ...available("00:00", "00:00"), start: Date.parse("2026-11-02T09:10:00+03:00"), end: Date.parse("2026-11-02T10:00:00+03:00") };
	assert.deepEqual(openSlots([[block]], { ...options, now: block.start - 3 * 3_600_000, slotMinutes: 15 }).map((slot) => new Date(slot.start).toISOString()), [
		"2026-11-02T06:15:00.000Z",
		"2026-11-02T06:30:00.000Z",
		"2026-11-02T06:45:00.000Z",
	]);
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
