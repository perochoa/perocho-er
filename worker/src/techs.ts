// The techs, from the TECHS secret.

export interface Tech {
	name: string;
	calendarId: string;
	email: string; // where their requests go; calendarId when TECHS leaves it out
}

// The secret is a JSON list of techs. Errors name TECHS but never echo it.
export function parseTechs(raw: string): Tech[] {
	let techs: unknown;
	try {
		techs = JSON.parse(raw);
	} catch {
		throw new Error("TECHS is not valid JSON");
	}
	const valid =
		Array.isArray(techs) &&
		techs.length > 0 &&
		techs.every(
			(tech) =>
				typeof tech?.name === "string" &&
				typeof tech?.calendarId === "string" &&
				(tech.email === undefined || typeof tech.email === "string"),
		);
	if (!valid) throw new Error("TECHS must be a non-empty array of { name, calendarId, email? } strings");
	return (techs as (Omit<Tech, "email"> & { email?: string })[]).map((tech) => ({
		...tech,
		email: tech.email ?? tech.calendarId,
	}));
}
