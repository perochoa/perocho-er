// Google Calendar through a service account. Each tech shares their calendar with the service
// account's email and gives it "Make changes to events".

import { type CalendarEvent, isAvailable } from "./slots.ts";

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

// Tokens last an hour; reuse one until 5 minutes before it expires. Module scope lives as long as
// the isolate, so this saves the signing and token exchange on most requests. Keyed on the key
// JSON so a rotated service account gets a new token.
let cached: { account: string; token: string; exp: number } | null = null;

export const resetTokenCache = () => {
	cached = null;
};

export async function accessToken(serviceAccountJson: string): Promise<string> {
	if (cached?.account === serviceAccountJson && Date.now() < cached.exp - 300_000) return cached.token;
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
	const { access_token, expires_in } = (await response.json()) as {
		access_token: string;
		expires_in: number;
	};
	cached = { account: serviceAccountJson, token: access_token, exp: Date.now() + expires_in * 1000 };
	return access_token;
}

interface GoogleEvent {
	id: string;
	created: string;
	summary?: string;
	transparency?: string;
	start: { dateTime?: string; date?: string };
	end: { dateTime?: string; date?: string };
	attendees?: { self?: boolean; responseStatus?: string }[];
}

// `id` and `created` let racing requests agree on whose hold came first.
export interface ListedEvent extends CalendarEvent {
	id: string;
	created: number;
}

export async function listEvents(
	token: string,
	calendarId: string,
	from: number,
	to: number,
): Promise<ListedEvent[]> {
	const query = new URLSearchParams({
		timeMin: new Date(from).toISOString(),
		timeMax: new Date(to).toISOString(),
		singleEvents: "true",
		maxResults: "2500",
		fields: "items(id,created,summary,transparency,start,end,attendees(self,responseStatus))",
	});
	const response = await fetch(`${API}/${encodeURIComponent(calendarId)}/events?${query}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`google events: ${response.status} ${await response.text()}`);
	const { items = [] } = (await response.json()) as { items?: GoogleEvent[] };

	return items.map((item) => ({
		id: item.id,
		created: Date.parse(item.created),
		start: Date.parse(item.start.dateTime ?? item.start.date ?? ""),
		end: Date.parse(item.end.dateTime ?? item.end.date ?? ""),
		allDay: !item.start.dateTime,
		transparent: item.transparency === "transparent",
		declined: item.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false,
		available: isAvailable(item.summary ?? ""),
	}));
}

export async function createHold(
	token: string,
	calendarId: string,
	hold: { summary: string; description: string; start: number; end: number; timeZone: string },
): Promise<{ id: string; created: number }> {
	const response = await fetch(`${API}/${encodeURIComponent(calendarId)}/events?fields=id,created`, {
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
	const event = (await response.json()) as Pick<GoogleEvent, "id" | "created">;
	return { id: event.id, created: Date.parse(event.created) };
}

export async function deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
	const response = await fetch(
		`${API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
	);
	// 410: already deleted, which is what we wanted.
	if (!response.ok && response.status !== 410) {
		throw new Error(`google delete: ${response.status} ${await response.text()}`);
	}
}
