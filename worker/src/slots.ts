// Open times from the techs' calendars. Pure, so it can be tested without Google.
//
// A tech is free during working hours, every day, except where a timed event of theirs overlaps.
// All-day events, events marked "Show as free" and invites they declined don't block anything.

export interface CalendarEvent {
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
	workHours: { start: number; end: number }; // minutes after local midnight
	timeZone: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const blocks = (event: CalendarEvent) => !event.allDay && !event.transparent && !event.declined;

// Parses "09:00-17:00" into minutes after midnight.
export function parseWorkHours(hours: string): { start: number; end: number } {
	const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(hours.trim());
	if (!match) throw new Error(`bad WORK_HOURS: ${hours}`);
	const [, h1, m1, h2, m2] = match.map(Number);
	return { start: h1 * 60 + m1, end: h2 * 60 + m2 };
}

// The local calendar date of `ms` in `timeZone`, and how far that zone is ahead of UTC then.
function local(ms: number, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(ms);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return { year: get("year"), month: get("month"), day: get("day"), offset: asUtc - Math.floor(ms / 1000) * 1000 };
}

// Epoch ms of `minutes` after midnight on a local date, across daylight saving changes.
function zoned(year: number, month: number, day: number, minutes: number, timeZone: string): number {
	const wall = Date.UTC(year, month - 1, day, 0, minutes);
	const guess = wall - local(wall, timeZone).offset;
	return wall - local(guess, timeZone).offset;
}

export function openSlots(eventsByTech: CalendarEvent[][], options: SlotOptions): Slot[] {
	const length = options.slotMinutes * MINUTE;
	const earliest = options.now + options.leadHours * HOUR;
	const latest = options.now + options.daysAhead * DAY;
	const today = local(options.now, options.timeZone);
	const slots = new Map<number, Slot>();

	eventsByTech.forEach((events, tech) => {
		const busy = events.filter(blocks);
		for (let i = 0; i <= options.daysAhead; i++) {
			const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
			const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
			const dayStart = zoned(y, m, d, options.workHours.start, options.timeZone);
			const dayEnd = zoned(y, m, d, options.workHours.end, options.timeZone);
			// Slots line up with the start of working hours.
			for (let start = dayStart; start + length <= dayEnd; start += length) {
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
