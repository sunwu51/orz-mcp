const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";

export default async function handler(request: Request): Promise<Response> {
  const inboundUrl = new URL(request.url);
  const upstreamUrl = new URL(DUCKDUCKGO_HTML_URL);
  upstreamUrl.search = inboundUrl.search;

  return fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
  });
}
