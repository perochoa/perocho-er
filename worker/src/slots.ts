// Open times from the techs' calendars. Pure, so it can be tested without Google.
//
// A tech is bookable only inside their own "Available..." blocks (any timed event whose title
// starts with "Available"), except where another timed event of theirs overlaps. All-day events,
// events marked "Show as free" and invites they declined don't block anything. The worker's own
// holds and bookings are "free": a time is a drop-off, and any number of customers can share one.

export interface CalendarEvent {
	start: number; // epoch ms
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
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const isAvailable = (summary: string) => /^\s*available/i.test(summary);

// Availability blocks are only read for free time; they never take it away.
export const blocks = (event: CalendarEvent) =>
	!event.allDay && !event.transparent && !event.declined && !event.available;

export function openSlots(eventsByTech: CalendarEvent[][], options: SlotOptions): Slot[] {
	const length = options.slotMinutes * MINUTE;
	const earliest = options.now + options.leadHours * HOUR;
	const latest = options.now + options.daysAhead * DAY;
	const slots = new Map<number, Slot>();

	eventsByTech.forEach((events, tech) => {
		const busy = events.filter(blocks);
		const free = events.filter((event) => event.available && !event.allDay && !event.declined);
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
