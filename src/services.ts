// The services collection, sorted as the page lists them, and their price lines.
import { type CollectionEntry, getCollection } from "astro:content";

export type Service = CollectionEntry<"services">;

export const getServices = async () =>
	(await getCollection("services")).sort((a, b) => a.data.order - b.data.order);

// Per-item services build their price line from their numbers, so the line and the JSON-LD price
// can't disagree.
export const priceText = ({ price, perItem }: Service["data"]) =>
	price ??
	(perItem
		? `$${perItem.price} per ${perItem.item}, or $${perItem.bulkPrice} per ${perItem.item} for ${perItem.bulkFrom} or more`
		: "Message us for a quote");

// The one price search engines get: the per-item price, or the first dollar amount in the free
// text ("$70, or $100 with..."). Unset when there's no price to give.
export const basePrice = ({ price, perItem }: Service["data"]) => {
	if (perItem) return perItem.price;
	const amount = price?.match(/^\$(\d+(?:\.\d+)?)/)?.[1];
	return amount ? Number(amount) : undefined;
};
