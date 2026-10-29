// Sends a plain-text email through Fastmail's JMAP API, from an identity on the token's account.

const SESSION = "https://api.fastmail.com/jmap/session";
const USING = [
	"urn:ietf:params:jmap:core",
	"urn:ietf:params:jmap:mail",
	"urn:ietf:params:jmap:submission",
];

type Call = [string, Record<string, unknown>, string];
type Response = [string, Record<string, any>, string];

export interface Mail {
	from: string;
	to: string;
	replyTo?: string;
	subject: string;
	text: string;
}

export async function sendMail(token: string, mail: Mail): Promise<void> {
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const sessionResponse = await fetch(SESSION, { headers });
	if (!sessionResponse.ok) throw new Error(`jmap session: ${sessionResponse.status}`);
	const session = (await sessionResponse.json()) as {
		apiUrl: string;
		primaryAccounts: Record<string, string>;
	};
	const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];

	const call = async (methodCalls: Call[]) => {
		const response = await fetch(session.apiUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({ using: USING, methodCalls }),
		});
		if (!response.ok) throw new Error(`jmap: ${response.status} ${await response.text()}`);
		const { methodResponses } = (await response.json()) as { methodResponses: Response[] };
		const error = methodResponses.find(([name]) => name === "error");
		if (error) throw new Error(`jmap: ${JSON.stringify(error[1])}`);
		return methodResponses;
	};

	const [identities, drafts, sent] = await call([
		["Identity/get", { accountId }, "identities"],
		["Mailbox/query", { accountId, filter: { role: "drafts" } }, "drafts"],
		["Mailbox/query", { accountId, filter: { role: "sent" } }, "sent"],
	]);
	const identity = identities[1].list.find(
		(i: { email: string }) => i.email.toLowerCase() === mail.from.toLowerCase(),
	);
	if (!identity) throw new Error(`jmap: no identity for ${mail.from}`);
	const draftsId: string = drafts[1].ids[0];
	const sentId: string = sent[1].ids[0];

	const [created, submitted] = await call([
		[
			"Email/set",
			{
				accountId,
				create: {
					draft: {
						mailboxIds: { [draftsId]: true },
						keywords: { $draft: true, $seen: true },
						from: [{ name: identity.name, email: identity.email }],
						to: [{ email: mail.to }],
						...(mail.replyTo && { replyTo: [{ email: mail.replyTo }] }),
						subject: mail.subject,
						bodyValues: { body: { value: mail.text } },
						textBody: [{ partId: "body", type: "text/plain" }],
					},
				},
			},
			"email",
		],
		[
			"EmailSubmission/set",
			{
				accountId,
				create: { send: { identityId: identity.id, emailId: "#draft" } },
				onSuccessUpdateEmail: {
					"#send": {
						[`mailboxIds/${draftsId}`]: null,
						[`mailboxIds/${sentId}`]: true,
						"keywords/$draft": null,
					},
				},
			},
			"submission",
		],
	]);
	if (created[1].notCreated) throw new Error(`jmap email: ${JSON.stringify(created[1].notCreated)}`);
	if (submitted[1].notCreated) {
		throw new Error(`jmap submission: ${JSON.stringify(submitted[1].notCreated)}`);
	}
}
