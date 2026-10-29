// Google Calendar through a service account. Each tech shares their calendar with the service
// account's email and gives it "Make changes to events".

import type { CalendarEvent } from "./slots.ts";

interface ServiceAccount {
	client_email: string;
	private_key: string;
}

const API = "https://www.googleapis.com/calendar/v3/calendars";

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function accessToken(serviceAccountJson: string): Promise<string> {
	const account: ServiceAccount = JSON.parse(serviceAccountJson);
	const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
	const key = await crypto.subtle.importKey(
		"pkcs8",
		Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
		iss: account.client_email,
		scope: "https://www.googleapis.com/auth/calendar.events",
		aud: "https://oauth2.googleapis.com/token",
		iat: now,
		exp: now + 3600,
	})}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsigned),
	);

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: `${unsigned}.${base64url(signature)}`,
		}),
	});
	if (!response.ok) throw new Error(`google token: ${response.status} ${await response.text()}`);
	return ((await response.json()) as { access_token: string }).access_token;
}

interface GoogleEvent {
	transparency?: string;
	start: { dateTime?: string; date?: string };
	end: { dateTime?: string; date?: string };
	attendees?: { self?: boolean; responseStatus?: string }[];
}

export async function listEvents(
	token: string,
	calendarId: string,
	from: number,
	to: number,
): Promise<CalendarEvent[]> {
	const query = new URLSearchParams({
		timeMin: new Date(from).toISOString(),
		timeMax: new Date(to).toISOString(),
		singleEvents: "true",
		maxResults: "2500",
		fields: "items(transparency,start,end,attendees(self,responseStatus))",
	});
	const response = await fetch(`${API}/${encodeURIComponent(calendarId)}/events?${query}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`google events: ${response.status} ${await response.text()}`);
	const { items = [] } = (await response.json()) as { items?: GoogleEvent[] };

	return items.map((item) => ({
		start: Date.parse(item.start.dateTime ?? item.start.date ?? ""),
		end: Date.parse(item.end.dateTime ?? item.end.date ?? ""),
		allDay: !item.start.dateTime,
		transparent: item.transparency === "transparent",
		declined: item.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false,
	}));
}

export async function createHold(
	token: string,
	calendarId: string,
	hold: { summary: string; description: string; start: number; end: number; timeZone: string },
): Promise<void> {
	const response = await fetch(`${API}/${encodeURIComponent(calendarId)}/events`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			summary: hold.summary,
			description: hold.description,
			start: { dateTime: new Date(hold.start).toISOString(), timeZone: hold.timeZone },
			end: { dateTime: new Date(hold.end).toISOString(), timeZone: hold.timeZone },
			status: "tentative",
			colorId: "5", // Banana: stands out until a tech confirms it.
		}),
	});
	if (!response.ok) throw new Error(`google insert: ${response.status} ${await response.text()}`);
}
