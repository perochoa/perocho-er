// The emails and calendar text a request produces, beyond the summary in intake.ts.

import type { Mail } from "./fastmail.ts";
import { describe, rushed, type StoredIntake as Intake, stop, what } from "./intake.ts";

export interface Offered {
	name: string;
	email: string;
	link: string;
	held: boolean;
}

type Message = Omit<Mail, "from">;

// What the techs and repairs@ see in a subject. Customers' subjects use `what` alone.
const about = (intake: Intake, time: string | null) => `${rushed(intake)} from ${intake.name}${time ? `, ${time}` : ""}`;
const subject = (intake: Intake, time: string | null) => `Repair request: ${about(intake, time)}`;

// New requests always have a time; `time` is null only for ones filed before times were required.

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
		...(intake.rush ? ["It's a rush: if you take it, it goes to the front of your queue."] : []),
		...(tech.held ? ["It's on your calendar as a tentative hold until someone takes it."] : []),
		"The time is when they drop it off. Call them to talk through the price and when it'll be ready, or reply to this email to reach them.",
	].join("\n"),
});

// Google shows an event's description as HTML, so a customer could hide a link of their own
// behind text like "Take it". Lookalike brackets keep what they wrote readable without any tags.
const untagged = (text: string) => text.replaceAll("<", "‹").replaceAll(">", "›");

export const holdDescription = (intake: Intake, time: string, link: string) =>
	`${untagged(describe(intake, time))}\n\nTake it or decline it: ${link}`;

export const bookedDescription = (intake: Intake, time: string, tech: string) =>
	`${untagged(describe(intake, time))}\n\nTaken by ${tech}. This is the drop-off; agree when it'll be ready with them. Delete this event to cancel, and let them know.`;

export const holdSummary = (intake: Intake) => `Request: ${rushed(intake)} (${intake.name})`;
export const bookedSummary = (intake: Intake) => `Repair: ${rushed(intake)} (${intake.name})`;

// For repairs@, which keeps a copy of everything without the links.
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
// Payment is in person, so the fee is only a note.
const rush = (intake: Intake) =>
	intake.rush ? [`You asked for a rush, so your repair goes to the front of the queue. That's +$${intake.rush}, paid in person with the repair.`] : [];
const yours = (intake: Intake, time: string | null) => ["", "Your request:", describe(intake, time)];

export const received = (intake: Intake, time: string): Message => ({
	to: intake.email,
	subject: `We got your repair request: ${what(intake)}`,
	text: [
		hi(intake),
		"",
		`Thanks! We've passed your request on to our techs. We'll email you again when one of them confirms your drop-off for ${stop(time)} Nothing is booked until then.`,
		...rush(intake),
		"A tech may call you to talk through the price. Once you've dropped it off, they'll let you know when it's ready. Reply to this email if anything changes.",
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
			? `${tech} has confirmed your repair. Drop off your device on ${stop(time)} ${tech} will let you know when it's ready to pick up.`
			: `${tech} has taken your repair and will be in touch to find a time.`,
		...rush(intake),
		"Reply to this email if you need the address or to change anything.",
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

export const expired = (intake: Intake, time: string | null): Message => ({
	to: intake.email,
	subject: `We couldn't take your repair request: ${what(intake)}`,
	text: [
		hi(intake),
		"",
		time
			? `Sorry, none of our techs could confirm ${stop(time)} Reply to this email and we'll try to find another time, or send the form again with a different one.`
			: "Sorry, none of our techs could take this one. Reply to this email if you'd like us to try again.",
		...yours(intake, time),
	].join("\n"),
});

// To the other techs and repairs@, so nobody plans around it any more.
export const taken = (intake: Intake, time: string | null, to: string, tech: string): Message => ({
	to,
	subject: `Taken by ${tech}: ${about(intake, time)}`,
	text: `${tech} took this request, so any hold for it comes off your calendar.\n\n${describe(intake, time)}`,
});

export const nobody = (intake: Intake, time: string | null, to: string): Message => ({
	to,
	subject: `Every tech declined: ${about(intake, time)}`,
	text: `Every tech declined this request, and the customer has been told.\n\n${describe(intake, time)}`,
});

export const unclaimed = (intake: Intake, time: string | null, to: string): Message => ({
	to,
	subject: `Nobody took: ${about(intake, time)}`,
	text: `Nobody took this request in time, so it's closed and the customer has been told.\n\n${describe(intake, time)}`,
});
