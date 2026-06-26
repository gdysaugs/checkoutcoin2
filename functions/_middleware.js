const CLOSED_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

export async function onRequest() {
  return new Response("This service is no longer available.", {
    status: 410,
    headers: CLOSED_HEADERS,
  });
}
