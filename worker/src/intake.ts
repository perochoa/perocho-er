// The intake form: parsing, validation and the summary every email and event about it shows.

export interface Intake {
	name: string;
	email: string;
	service: string;
	device: string;
	problem: string;
	visit: "drop-off" | "house-call";
	slot: number | null; // epoch ms, or null when they'll arrange a time later
	notes: string;
}

export type Parsed = { ok: true; intake: Intake } | { ok: false; spam: boolean };

const VISITS = ["drop-off", "house-call"] as const;

// Loose on purpose: catches typos and junk, not every invalid address.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const oneOf = <T extends string>(values: readonly T[], value: string): value is T =>
	(values as readonly string[]).includes(value);

export function parseIntake(form: FormData): Parsed {
	// Single-line unless told otherwise: CR/LF would leak into subjects and summaries.
	const field = (name: string, max: number, multiline = false) => {
		const value = form.get(name);
		if (typeof value !== "string") return "";
		return (multiline ? value : value.replace(/\s+/g, " ")).trim().slice(0, max);
	};

	// Hidden from people; bots fill it in.
	if (field("website", 200)) return { ok: false, spam: true };

	const visit = field("visit", 20);
	const slotText = field("slot", 40);
	const slot = slotText ? Date.parse(slotText) : null;
	const fields = {
		name: field("name", 100),
		email: field("email", 200),
		service: field("service", 150),
		device: field("device", 150),
		problem: field("problem", 2000, true),
		notes: field("notes", 2000, true),
	};

	const invalid = { ok: false, spam: false } as const;
	if (!oneOf(VISITS, visit)) return invalid;

	const valid =
		fields.name !== "" &&
		fields.device !== "" &&
		fields.problem !== "" &&
		EMAIL.test(fields.email) &&
		(slot === null || !Number.isNaN(slot));

	if (!valid) return invalid;
	return { ok: true, intake: { ...fields, visit, slot } };
}

const VISIT_LABELS = { "drop-off": "Drop-off", "house-call": "House call" };

export function formatTime(ms: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(ms);
}

// Ends a sentence on a time without doubling the period of "a.m." and "p.m.".
export const stop = (time: string) => (time.endsWith(".") ? time : `${time}.`);

export function describe(intake: Intake, time: string | null): string {
	const lines = [
		["Name", intake.name],
		["Email", intake.email],
		["Service", intake.service],
		["Device", intake.device],
		["Visit", VISIT_LABELS[intake.visit]],
		["Requested time", time ?? "None picked; arrange with them"],
	]
		.filter(([, value]) => value)
		.map(([label, value]) => `${label}: ${value}`);

	lines.push("", "What's wrong:", intake.problem);
	if (intake.notes) lines.push("", "Notes:", intake.notes);
	return lines.join("\n");
}

// What the request is for: the chosen service, else the device.
export const what = (intake: Intake) => intake.service || intake.device;
