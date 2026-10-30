// The home page's JSON-LD (schema.org), for search engines and AI assistants: the business, its
// services and prices, and the site. Built from the same details the page shows.
import { marketplace } from "./reviews";
import { basePrice, getServices, priceText } from "./services";
import { site } from "./site";

export async function homeStructuredData(origin: URL) {
	const url = new URL("/", origin).href;
	const business = `${url}#business`;
	const services = await getServices();
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${url}#website`,
				url,
				name: site.name,
				description: site.description,
				inLanguage: "en-CA",
				publisher: { "@id": business },
			},
			{
				"@type": "LocalBusiness",
				"@id": business,
				name: site.name,
				description: site.description,
				url,
				email: site.email,
				image: new URL("/og-image.png", origin).href,
				// Drop-off only, and the street address is given by message, so only the city.
				address: {
					"@type": "PostalAddress",
					addressLocality: "Mississauga",
					addressRegion: "ON",
					addressCountry: "CA",
				},
				areaServed: { "@type": "City", name: "Mississauga" },
				// As the "At a glance" strip and the steps say.
				paymentAccepted: "Cash, Interac e-Transfer",
				currenciesAccepted: "CAD",
				// The Marketplace rating stays out: Google doesn't take ratings gathered from another site.
				sameAs: marketplace ? [marketplace.url] : [],
				hasOfferCatalog: {
					"@type": "OfferCatalog",
					name: "PS5 repairs and upgrades",
					itemListElement: services.map(({ data }) => {
						const price = basePrice(data);
						return {
							"@type": "Offer",
							itemOffered: { "@type": "Service", name: data.title, provider: { "@id": business } },
							description: priceText(data),
							...(price !== undefined && { price, priceCurrency: "CAD" }),
						};
					}),
				},
			},
		],
	};
}
