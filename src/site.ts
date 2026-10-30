// Site-wide details. Optional fields stay unset until known; the page hides what's unset.

interface Site {
	name: string;
	tagline: string;
	intro: string;
	description: string;
	email: string;
	messengerUrl: string;
	marketplace?: {
		url: string;
		// Update by hand from the Marketplace profile now and then.
		stars: number;
		ratings: number;
	};
	serviceArea?: string;
	hours?: string;
	// The intake Worker (worker/). Unset hides the request form and every link to it.
	intakeUrl?: string;
	// Dollars added to move a repair to the front of the queue. Keep RUSH_FEE in worker/wrangler.jsonc the same.
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
	marketplace: {
		url: "https://www.facebook.com/marketplace/profile/1786877701",
		stars: 5,
		ratings: 75,
	},
	serviceArea: "Mississauga, drop-off only. Message us for the address.",
	// Assumes the request form is on (intakeUrl): its times come from the techs' calendars.
	hours: "Whenever a tech is free. The request form shows the open times.",
	intakeUrl: "https://perocho-intake.perocho-xela.workers.dev",
	rushFee: 20,
};
