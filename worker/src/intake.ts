// The intake form: parsing, validation and the summary every email and event about it shows.

export interface Intake {
	name: string;
	email: string;
	phone: string;
	service: string;
	device: string;
	problem: string;
	slot: number; // epoch ms of the drop-off time they picked
	notes: string;
	// The rush fee in dollars they agreed to, 0 for none. Kept as a fee, not a flag, so a later
	// change to RUSH_FEE doesn't change what earlier customers were quoted.
	rush: number;
}

export type Parsed = { ok: true; intake: Intake } | { ok: false; spam: boolean };

// Loose on purpose: catches typos and junk, not every invalid address.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Also loose: digits with the usual separators and an optional leading +, 10 to 15 digits
// (a local number with its area code, up to an international one). Kept as they typed it.
const PHONE = /^\+?[\d\s().-]+$/;
const digits = (phone: string) => phone.replace(/\D/g, "").length;
const validPhone = (phone: string) => PHONE.test(phone) && digits(phone) >= 10 && digits(phone) <= 15;

// For a tel: link: the digits, and the + if they gave one.
export const dialable = (phone: string) => (phone.trim().startsWith("+") ? "+" : "") + phone.replace(/\D/g, "");

export function parseIntake(form: FormData, rushFee: number): Parsed {
	// Single-line unless told otherwise: CR/LF would leak into subjects and summaries.
	const field = (name: string, max: number, multiline = false) => {
		const value = form.get(name);
		if (typeof value !== "string") return "";
		return (multiline ? value : value.replace(/\s+/g, " ")).trim().slice(0, max);
	};

	// Hidden from people; bots fill it in.
	if (field("website", 200)) return { ok: false, spam: true };

	// Required: the form only sends once a time is picked.
	const slot = Date.parse(field("slot", 40));
	const fields = {
		name: field("name", 100),
		email: field("email", 200),
		phone: field("phone", 30),
		service: field("service", 150),
		device: field("device", 150),
		problem: field("problem", 2000, true),
		notes: field("notes", 2000, true),
	};

	const valid =
		fields.name !== "" &&
		fields.device !== "" &&
		fields.problem !== "" &&
		EMAIL.test(fields.email) &&
		validPhone(fields.phone) &&
		!Number.isNaN(slot);

	if (!valid) return { ok: false, spam: false };
	return { ok: true, intake: { ...fields, slot, rush: form.get("rush") === "1" ? rushFee : 0 } };
}

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

export function describe(intake: Intake, time: string): string {
	const lines = [
		["Name", intake.name],
		["Email", intake.email],
		["Phone", intake.phone],
		["Service", intake.service],
		["Device", intake.device],
		["Drop-off time", time],
		["Rush", intake.rush ? `yes, +$${intake.rush} (paid in person)` : ""],
	]
		.filter(([, value]) => value)
		.map(([label, value]) => `${label}: ${value}`);

	lines.push("", "What's wrong:", intake.problem);
	if (intake.notes) lines.push("", "Notes:", intake.notes);
	return lines.join("\n");
}

// What the request is for: the chosen service, else the device.
export const what = (intake: Intake) => intake.service || intake.device;

// Leads what the techs see about a request, so a rush stands out in a list of emails or events.
export const rushed = (intake: Intake) => (intake.rush ? `RUSH ${what(intake)}` : what(intake));
