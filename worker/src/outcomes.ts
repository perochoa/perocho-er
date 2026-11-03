// Where the worker sends people after they submit the form: /request/<outcome>/ on the site. The
// site's [outcome].astro has a page for each, and `astro check` fails if one is missing.
export type Outcome = "sent" | "closed" | "failed";
