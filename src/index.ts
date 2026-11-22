import { run } from "./run";
import type { Env } from "./env";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      run(env, new Date(controller.scheduledTime)).catch((error) => {
        console.error("scheduled run failed", error);
        throw error;
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const expected = `Bearer ${env.RUN_TOKEN}`;
      if (!env.RUN_TOKEN || request.headers.get("authorization") !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json(await run(env, new Date()));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
