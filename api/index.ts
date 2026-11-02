const docsUrl = "https://chusdrter.gitbook.io/underwrite/";
const repositoryUrl = "https://github.com/UnderWritex402/UnderWrite-app";

const securityHeaders = {
  "cache-control": "public, max-age=0, s-maxage=300",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function healthResponse(): Response {
  return Response.json(
    {
      service: "underwrite-agent",
      status: "ok",
      version: "0.1.0",
      network: "stellar-testnet",
      interface: "operator-cli",
      documentation: docsUrl,
      repository: repositoryUrl,
    },
    { headers: securityHeaders },
  );
}

function landingResponse(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>UnderWrite Agent</title>
    <meta name="description" content="Invoice verification and signed risk attestations for Stellar invoice financing.">
    <style>
      :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8edf7; }
      main { width: min(42rem, calc(100% - 3rem)); }
      .status { color: #70e1a1; }
      h1 { font-size: clamp(2.4rem, 8vw, 5rem); margin: 1rem 0; letter-spacing: -.06em; }
      p { color: #a9b4c8; line-height: 1.7; max-width: 38rem; }
      nav { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 2rem; }
      a { color: #0b1020; background: #e8edf7; padding: .75rem 1rem; text-decoration: none; border-radius: .35rem; }
      a.secondary { color: #e8edf7; background: transparent; border: 1px solid #45516a; }
    </style>
  </head>
  <body>
    <main>
      <div class="status">● service online · v0.1.0 · Stellar testnet</div>
      <h1>UnderWrite</h1>
      <p>Invoice verification and signed risk attestations for Stellar invoice financing. Verification is operated through the authenticated command-line workflow documented below.</p>
      <nav>
        <a href="${docsUrl}">Read the documentation</a>
        <a class="secondary" href="${repositoryUrl}">View the source</a>
        <a class="secondary" href="/health">Health JSON</a>
      </nav>
    </main>
  </body>
</html>`;

  return new Response(html, {
    headers: { ...securityHeaders, "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  fetch(request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { ...securityHeaders, allow: "GET, HEAD" } },
      );
    }

    const { pathname } = new URL(request.url);
    const response = pathname === "/health" ? healthResponse() : landingResponse();
    return request.method === "HEAD"
      ? new Response(null, { status: response.status, headers: response.headers })
      : response;
  },
};
