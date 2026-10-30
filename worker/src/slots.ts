// Open times from the techs' calendars. Pure, so it can be tested without Google.
//
// A tech is bookable only inside their own "Available..." blocks (any event whose title starts
// with "Available"; an all-day one means 9 a.m. to 7 p.m. each day it covers), except where
// another timed event of theirs overlaps. All-day events, events marked "Show as free" and
// invites they declined don't block anything. The worker's own
// holds and bookings are "free": a time is a drop-off, and any number of customers can share one.

export interface CalendarEvent {
	start: number; // epoch ms; an all-day event's dates are midnight UTC, end exclusive
	end: number;
	allDay: boolean;
	transparent: boolean;
	declined: boolean;
	available: boolean; // an "Available..." block
}

export interface Slot {
	start: number;
	end: number;
	// Indexes into the techs list, in list order: who is free for the whole slot.
	techs: number[];
}

export interface SlotOptions {
	now: number;
	slotMinutes: number;
	leadHours: number;
	daysAhead: number;
	timeZone: string; // places all-day blocks' hours
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The hours an all-day "Available" block stands for, in the worker's time zone.
export const ALL_DAY_FROM = 9;
export const ALL_DAY_TO = 19;

export const isAvailable = (summary: string) => /^\s*available/i.test(summary);

// Availability blocks are only read for free time; they never take it away.
export const blocks = (event: CalendarEvent) =>
	!event.allDay && !event.transparent && !event.declined && !event.available;

// How far timeZone's clock is ahead of UTC at a moment, in ms.
function offset(ms: number, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(ms);
	const part = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
	return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - ms;
}

// The moment it's `hour` o'clock on a date (midnight UTC) in timeZone. Taking the offset a second
// time gets it right on the days the clocks change.
function wallClock(date: number, hour: number, timeZone: string) {
	const local = date + hour * HOUR;
	const guess = local - offset(local, timeZone);
	return local - offset(guess, timeZone);
}

// An all-day block as one timed block per day it covers.
const daytime = (event: CalendarEvent, timeZone: string) => {
	const days: CalendarEvent[] = [];
	for (let date = event.start; date < event.end; date += DAY) {
		days.push({
			...event,
			allDay: false,
			start: wallClock(date, ALL_DAY_FROM, timeZone),
			end: wallClock(date, ALL_DAY_TO, timeZone),
		});
	}
	return days;
};

export function openSlots(eventsByTech: CalendarEvent[][], options: SlotOptions): Slot[] {
	const length = options.slotMinutes * MINUTE;
	const earliest = options.now + options.leadHours * HOUR;
	const latest = options.now + options.daysAhead * DAY;
	const slots = new Map<number, Slot>();

	eventsByTech.forEach((events, tech) => {
		const busy = events.filter(blocks);
		const free = events
			.filter((event) => event.available && !event.declined)
			.flatMap((event) => (event.allDay ? daytime(event, options.timeZone) : [event]));
		for (const block of free) {
			// Times fall on whole steps: the block's start rounded up to the next multiple of the
			// slot length since the epoch, which is midnight UTC. Every whole-hour offset keeps
			// that on the hour, so 15 minutes gives :00, :15, :30 and :45 in TIME_ZONE, as does any
			// length that divides an hour. A 13:05 block starts at 13:15.
			const first = Math.ceil(block.start / length) * length;
			for (let start = first; start + length <= block.end; start += length) {
				const end = start + length;
				if (start < earliest || end > latest) continue;
				if (busy.some((event) => event.start < end && event.end > start)) continue;
				const slot = slots.get(start) ?? { start, end, techs: [] };
				// Techs go in index order, so pushing keeps `techs` ascending. The check is still
				// needed: a tech's overlapping blocks reach the same start twice.
				if (!slot.techs.includes(tech)) slot.techs.push(tech);
				slots.set(start, slot);
			}
		}
	});

	return [...slots.values()].sort((a, b) => a.start - b.start);
}
