// Open times from the techs' calendars. Pure, so it can be tested without Google.
//
// A tech is bookable only inside their own "Available..." blocks (any timed event whose title
// starts with "Available"), except where another timed event of theirs overlaps. All-day events,
// events marked "Show as free" and invites they declined don't block anything.

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
			// Slots line up with the start of the block.
			for (let start = block.start; start + length <= block.end; start += length) {
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
