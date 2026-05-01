// Mock upstream server 返回 502 Bad Gateway

const PORT = 19991;

Deno.serve({ port: PORT }, (req) => {
  console.log(`[Mock 502] 收到请求: ${req.method} ${new URL(req.url).pathname}`);

  // 返回 502 Bad Gateway
  return new Response(
    JSON.stringify({ error: { message: "Bad Gateway - upstream error" } }),
    {
      status: 502,
      headers: { "Content-Type": "application/json" }
    }
  );
});

console.log(`[Mock 502] Listening on http://localhost:${PORT}/`);