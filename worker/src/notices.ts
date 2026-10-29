// The emails and calendar text a request produces, beyond the summary in intake.ts.

import type { Mail } from "./fastmail.ts";
import { describe, type Intake, stop, what } from "./intake.ts";

export interface Offered {
	name: string;
	email: string;
	link: string;
	held: boolean;
}

type Message = Omit<Mail, "from">;

const subject = (intake: Intake, time: string | null) =>
	`Repair request: ${what(intake)} from ${intake.name}${time ? `, ${time}` : ""}`;

// The same request to every tech, each with their own link.
export const toTech = (intake: Intake, time: string | null, tech: Offered): Message => ({
	to: tech.email,
	replyTo: intake.email,
	subject: subject(intake, time),
	text: [
		describe(intake, time),
		"",
		`Take it or decline it: ${tech.link}`,
		"The first tech to take it gets it. Declining only takes you out; the others can still take it.",
		...(tech.held ? ["It's on your calendar as a tentative hold until someone takes it."] : []),
		"Reply to this email to reach them.",
	].join("\n"),
});

export const holdDescription = (intake: Intake, time: string, link: string) =>
	`${describe(intake, time)}\n\nTake it or decline it: ${link}`;

export const bookedDescription = (intake: Intake, time: string, tech: string) =>
	`${describe(intake, time)}\n\nTaken by ${tech}. Delete this event to cancel, and let them know.`;

export const holdSummary = (intake: Intake) => `Request: ${what(intake)} (${intake.name})`;
export const bookedSummary = (intake: Intake) => `Repair: ${what(intake)} (${intake.name})`;

// For contact@, which keeps a copy of everything without the links.
export const record = (intake: Intake, time: string | null, to: string, techs: Offered[]): Message => {
	const held = techs.filter((tech) => tech.held).map((tech) => tech.name);
	return {
		to,
		replyTo: intake.email,
		subject: subject(intake, time),
		text: [
			describe(intake, time),
			"",
			`Sent to: ${techs.map((tech) => tech.name).join(", ")}`,
			...(held.length > 0 ? [`Held on: ${held.join(", ")} (tentative)`] : []),
		].join("\n"),
	};
};

const hi = (intake: Intake) => `Hi ${intake.name},`;
const yours = (intake: Intake, time: string | null) => ["", "Your request:", describe(intake, time)];

export const received = (intake: Intake, time: string | null): Message => ({
	to: intake.email,
	subject: `We got your repair request: ${what(intake)}`,
	text: [
		hi(intake),
		"",
		time
			? `Thanks! We've passed your request on to our techs. We'll email you again when one of them confirms ${stop(time)} Nothing is booked until then.`
			: "Thanks! We've passed your request on to our techs, and one of them will email you to find a time.",
		"Reply to this email if anything changes.",
		...yours(intake, time),
	].join("\n"),
});

export const failed = (intake: Intake): Message => ({
	to: intake.email,
	subject: `Your repair request didn't go through: ${what(intake)}`,
	text: [
		hi(intake),
		"",
		"Something went wrong on our end, and your request wasn't sent to our techs. Please try the form again, or reply to this email with the details and we'll take it from there.",
		"",
		"Sorry about that.",
	].join("\n"),
});

export const confirmed = (intake: Intake, time: string | null, tech: string): Message => ({
	to: intake.email,
	subject: `Your repair is confirmed: ${what(intake)}${time ? `, ${time}` : ""}`,
	text: [
		hi(intake),
		"",
		time
			? `${tech} has confirmed your repair for ${stop(time)}`
			: `${tech} has taken your repair and will be in touch to find a time.`,
		"Reply to this email if you need to change anything.",
		...yours(intake, time),
	].join("\n"),
});

export const declined = (intake: Intake, time: string | null): Message => ({
	to: intake.email,
	subject: `We can't take your repair request: ${what(intake)}`,
	text: [
		hi(intake),
		"",
		time
			? `Sorry, none of our techs can make ${stop(time)} Reply to this email and we'll try to find another time, or send the form again with a different one.`
			: "Sorry, none of our techs can take this one right now. Reply to this email if you'd like us to try again later.",
		...yours(intake, time),
	].join("\n"),
});

// To the other techs and contact@, so nobody plans around it any more.
export const taken = (intake: Intake, time: string | null, to: string, tech: string): Message => ({
	to,
	subject: `Taken by ${tech}: ${what(intake)} from ${intake.name}${time ? `, ${time}` : ""}`,
	text: `${tech} took this request, so any hold for it on your calendar is gone.\n\n${describe(intake, time)}`,
});

export const nobody = (intake: Intake, time: string | null, to: string): Message => ({
	to,
	subject: `Every tech declined: ${what(intake)} from ${intake.name}${time ? `, ${time}` : ""}`,
	text: `Every tech declined this request, and the customer has been told.\n\n${describe(intake, time)}`,
});
