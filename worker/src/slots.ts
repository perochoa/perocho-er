// Open times from the techs' calendars. Pure, so it can be tested without Google.
//
// A tech is free during an event whose title starts with "Available", except where any other
// timed event of theirs overlaps it. All-day events, events marked "Show as free" and invites
// they declined don't block anything.

export interface CalendarEvent {
	summary: string;
	start: number; // epoch ms
	end: number;
	allDay: boolean;
	transparent: boolean;
	declined: boolean;
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

export const isAvailability = (event: CalendarEvent) =>
	!event.allDay && /^available\b/i.test(event.summary.trim());

const blocks = (event: CalendarEvent) =>
	!event.allDay && !event.transparent && !event.declined && !isAvailability(event);

export function openSlots(eventsByTech: CalendarEvent[][], options: SlotOptions): Slot[] {
	const length = options.slotMinutes * MINUTE;
	const earliest = options.now + options.leadHours * HOUR;
	const latest = options.now + options.daysAhead * DAY;
	const slots = new Map<number, Slot>();

	eventsByTech.forEach((events, tech) => {
		const busy = events.filter(blocks);
		for (const block of events.filter(isAvailability)) {
			// Slots line up with the start of the "Available" block.
			for (let start = block.start; start + length <= block.end; start += length) {
				const end = start + length;
				if (start < earliest || end > latest) continue;
				if (busy.some((event) => event.start < end && event.end > start)) continue;
				const slot = slots.get(start) ?? { start, end, techs: [] };
				if (!slot.techs.includes(tech)) slot.techs.push(tech);
				slots.set(start, slot);
			}
		}
	});

	for (const slot of slots.values()) slot.techs.sort((a, b) => a - b);
	return [...slots.values()].sort((a, b) => a.start - b.start);
}
