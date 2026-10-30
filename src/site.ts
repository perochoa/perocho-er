// Site-wide details. Optional fields stay unset until known; the page hides what's unset.

interface Site {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	email: string;
	messengerUrl: string;
	// Opens the chat in the Messenger app. Phones use it first: m.me has no web chat on a phone for a
	// personal profile, and Safari/Firefox on iOS don't always hand m.me to the app.
	messengerAppUrl: string;
	serviceArea?: string;
	hours?: string;
	// The intake Worker (worker/). Unset hides the request form and every link to it.
	intakeUrl?: string;
	// Dollars added to move a repair to the front of the queue. worker/src/config.test.ts checks it
	// matches RUSH_FEE in worker/wrangler.jsonc.
	rushFee: number;
}

export const site: Site = {
	name: "Perocho Repairs",
	tagline: "PS5 repairs and upgrades in Mississauga.",
	intro: "Stick drift, overheating and HDMI port fixes from a family-run shop.",
	description:
		"Family-run PS5 repairs and upgrades in Mississauga: stick drift fixes, deep cleaning and HDMI port replacement.",
	email: "repairs@perocho.com",
	messengerUrl: "https://m.me/richard.perocho",
	messengerAppUrl: "fb-messenger://user-thread/1786877701",
	serviceArea: "Mississauga, drop-off only. Message us for the address.",
	// Assumes the request form is on (intakeUrl): its times come from the techs' calendars.
	hours: "Drop-off whenever a tech can take devices in. The request form shows the open times.",
	intakeUrl: "https://perocho-intake.perocho-xela.workers.dev",
	rushFee: 20,
};
