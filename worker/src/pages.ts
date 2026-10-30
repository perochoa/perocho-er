// The HTML shell of the pages a tech's link opens: the request and their queue.

// The pages need nothing but their inline styles and forms that post back here. Customer text is
// escaped too; this is in case something slips through, and keeps the pages out of frames.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export const escape = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const html = (title: string, body: string, status = 200) =>
	new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
	:root { color-scheme: light dark; --muted: #666; --accent: #1f6feb; --line: #ddd; }
	@media (prefers-color-scheme: dark) { :root { --muted: #aaa; --accent: #58a6ff; --line: #333; } }
	body { font: 1rem/1.5 system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 2rem 1rem; }
	h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
	.state { color: var(--muted); margin: 0 0 1.5rem; }
	pre { white-space: pre-wrap; font: inherit; border: 1px solid var(--line); border-radius: 0.5rem; padding: 1rem; margin: 0 0 1.5rem; }
	form { display: flex; gap: 0.75rem; flex-wrap: wrap; }
	button { font: inherit; font-weight: 600; padding: 0.6rem 1.2rem; border-radius: 0.5rem; border: 1px solid var(--accent); cursor: pointer; background: none; color: var(--accent); }
	button[value="confirm"] { background: var(--accent); color: Canvas; }
	.call { margin: 0 0 1rem; }
	.rush { margin: 0 0 1rem; font-weight: 700; }
	.mine { margin: 1.5rem 0 0; }
	.mine a, .queue a { color: var(--accent); }
	.queue { padding-left: 1.5rem; margin: 0 0 1.5rem; }
	.queue li { margin: 0 0 1rem; }
	.queue .what { font-weight: 600; }
	.queue .details { color: var(--muted); }
	.call a { color: var(--accent); font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`,
		{
			status,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": CSP,
			},
		},
	);
