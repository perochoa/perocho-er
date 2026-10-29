// The intake form: parsing, validation and the text the techs receive.

export interface Intake {
	name: string;
	contact: "email" | "text" | "messenger";
	email: string;
	phone: string;
	facebook: string;
	service: string;
	device: string;
	problem: string;
	visit: "drop-off" | "house-call";
	slot: number | null; // epoch ms, or null when they'll arrange a time later
	notes: string;
}

export type Parsed = { ok: true; intake: Intake } | { ok: false; spam: boolean };

const CONTACTS = ["email", "text", "messenger"] as const;
const VISITS = ["drop-off", "house-call"] as const;

// Loose on purpose: catches typos and junk, not every invalid address.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const oneOf = <T extends string>(values: readonly T[], value: string): value is T =>
	(values as readonly string[]).includes(value);

export function parseIntake(form: FormData): Parsed {
	const field = (name: string, max: number) => {
		const value = form.get(name);
		return typeof value === "string" ? value.trim().slice(0, max) : "";
	};

	// Hidden from people; bots fill it in.
	if (field("website", 200)) return { ok: false, spam: true };

	const contact = field("contact", 20);
	const visit = field("visit", 20);
	const slotText = field("slot", 40);
	const slot = slotText ? Date.parse(slotText) : null;
	const fields = {
		name: field("name", 100),
		email: field("email", 200),
		phone: field("phone", 40),
		facebook: field("facebook", 100),
		service: field("service", 150),
		device: field("device", 150),
		problem: field("problem", 2000),
		notes: field("notes", 2000),
	};

	const reachable =
		(contact === "email" && EMAIL.test(fields.email)) ||
		(contact === "text" && fields.phone.replace(/\D/g, "").length >= 10) ||
		(contact === "messenger" && fields.facebook !== "");
	const valid =
		fields.name !== "" &&
		fields.device !== "" &&
		fields.problem !== "" &&
		oneOf(CONTACTS, contact) &&
		oneOf(VISITS, visit) &&
		reachable &&
		(slot === null || !Number.isNaN(slot));

	if (!valid) return { ok: false, spam: false };
	return { ok: true, intake: { ...fields, contact, visit, slot } as Intake };
}

const CONTACT_LABELS = { email: "Email", text: "Text", messenger: "Messenger" };
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

export function describe(intake: Intake, time: string | null, tech: string | null): string {
	const lines = [
		["Name", intake.name],
		["Reach them by", CONTACT_LABELS[intake.contact]],
		["Email", intake.email],
		["Phone", intake.phone],
		["Facebook", intake.facebook],
		["Service", intake.service],
		["Device", intake.device],
		["Visit", VISIT_LABELS[intake.visit]],
		["Requested time", time ?? "None picked; arrange with them"],
		["Held on", tech ? `${tech}'s calendar (tentative)` : ""],
	]
		.filter(([, value]) => value)
		.map(([label, value]) => `${label}: ${value}`);

	lines.push("", "What's wrong:", intake.problem);
	if (intake.notes) lines.push("", "Notes:", intake.notes);
	return lines.join("\n");
}

// The email is optional when they picked text or Messenger, so it's only checked here: a malformed
// Reply-To would make Fastmail reject the whole email, and the request isn't worth refusing over it.
export const replyTo = (intake: Intake) => (EMAIL.test(intake.email) ? intake.email : undefined);

export const subject = (intake: Intake, time: string | null) =>
	`Repair request: ${intake.service || intake.device} from ${intake.name}${time ? `, ${time}` : ""}`;
