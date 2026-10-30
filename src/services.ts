// The services collection, sorted as the page lists them, and their price lines.
import { type CollectionEntry, getCollection } from "astro:content";

type Service = CollectionEntry<"services">;

export const getServices = async () =>
	(await getCollection("services")).sort((a, b) => a.data.order - b.data.order);

// Per-item services build their price line from the calculator's numbers, so the two can't disagree.
export const priceText = ({ price, perItem }: Service["data"]) =>
	price ??
	(perItem
		? `$${perItem.price} per ${perItem.item}, or $${perItem.bulkPrice} per ${perItem.item} for ${perItem.bulkFrom} or more`
		: "Message us for a quote");

