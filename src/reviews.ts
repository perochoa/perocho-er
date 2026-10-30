// From the Marketplace profile (site.marketplace.url). Update by hand now and then, with the
// star rating and count in site.ts. Quotes have spelling, grammar and punctuation fixed, but keep
// the buyer's words and meaning: don't add claims they didn't make.

interface Review {
	// First name only, as Marketplace shows it.
	name: string;
	date: string;
	stars: number;
	// The strengths the buyer ticked.
	notable: string[];
	text: string;
}

export const marketplace = {
	// Marketplace's "Highly rated" badge: 4.5 stars or higher from at least 5 buyers.
	highlyRated: true,
	// Strengths buyers ticked, with how many ticked each.
	strengths: [
		{ label: "Communication", count: 46 },
		{ label: "Punctuality", count: 43 },
		{ label: "Pricing", count: 24 },
		{ label: "Item description", count: 20 },
	],
	reviews: [
		{
			name: "Michelle",
			date: "2026-10-13",
			stars: 5,
			notable: ["Punctuality", "Communication", "Pricing", "Item description"],
			text: "Amazing work, done for me in a couple of hours or even earlier, on the same day. Very helpful. Five stars!",
		},
		{
			name: "Aidan",
			date: "2026-10-09",
			stars: 5,
			notable: ["Communication", "Pricing"],
			text: "He did an awesome job. He helped me fix all the problems that needed to be fixed, he only charged me $100 for everything, and everything works perfectly.",
		},
		{
			name: "Sam",
			date: "2026-09-29",
			stars: 5,
			notable: ["Punctuality", "Communication", "Pricing", "Item description"],
			text: "Perfect! Thank you",
		},
	] satisfies Review[],
};
