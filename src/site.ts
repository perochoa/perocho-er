// Site-wide details. Optional fields stay unset until known; the page hides what's unset.

interface Site {
	name: string;
	tagline: string;
	description: string;
	email: string;
	messengerUrl: string;
	serviceArea?: string;
	hours?: string;
}

export const site: Site = {
	name: "Perocho ER",
	tagline: "The ER for your electronics.",
	description: "Family-run electronics repair and cleaning. Message us for a quote.",
	email: "contact@perocho.com",
	// TODO: Facebook profile username (DECISIONS.md, open question 3). Required before launch.
	messengerUrl: "https://m.me/TODO",
	// TODO: service area and hours (DECISIONS.md, open question 2).
};
