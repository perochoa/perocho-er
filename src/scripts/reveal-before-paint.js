// Hides [data-reveal] blocks before the first paint, so they don't show and then vanish when the
// scroll-in script in the base layout starts. Only with IntersectionObserver and without reduced
// motion: otherwise, or if that script never runs, everything is simply there.
// Inlined in <head> as is, so it runs before the first paint; the layout adds its hash to the CSP.
if (matchMedia("(prefers-reduced-motion: no-preference)").matches && "IntersectionObserver" in window) {
	const root = document.documentElement;
	root.classList.add("reveal-on");
	addEventListener("DOMContentLoaded", () => {
		if (!root.classList.contains("reveal-ready")) root.classList.remove("reveal-on");
	});
}
