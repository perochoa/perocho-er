// A pointer-following glow on the sections' cards (styles/sections.css draws it from --x and --y).
document.querySelectorAll<HTMLElement>(".card").forEach((card) => {
	card.addEventListener("pointermove", (event) => {
		const rect = card.getBoundingClientRect();
		card.style.setProperty("--x", `${event.clientX - rect.left}px`);
		card.style.setProperty("--y", `${event.clientY - rect.top}px`);
	});
});
