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
}

export const site: Site = {
	name: "Perocho Repairs",
	tagline: "PS5 repairs and upgrades in Mississauga.",
	intro: "Stick drift, overheating and HDMI port fixes from a family-run shop.",
	description:
		"Family-run PS5 repairs and upgrades in Mississauga: stick drift fixes, deep cleaning and HDMI port replacement.",
	email: "contact@perocho.com",
	messengerUrl: "https://m.me/richard.perocho",
	marketplace: {
		url: "https://www.facebook.com/marketplace/profile/1786877701",
		stars: 5,
		ratings: 75,
	},
	serviceArea: "Mississauga. Drop off, or we come to you. Message us for details.",
	hours: "Flexible. Message us and we'll find a time that works.",
	intakeUrl: "https://perocho-intake.perocho-xela.workers.dev",
};
