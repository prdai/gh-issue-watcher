import type { Env } from "./env.ts";

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(env: Env, email: OutgoingEmail): Promise<void> {
  await env.EMAIL.send({
    to: email.to,
    from: email.from,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}
