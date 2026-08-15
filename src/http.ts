const startedAt = Date.now();

export function handleRequest(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      status: "ok",
      service: "curio",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
    });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}
