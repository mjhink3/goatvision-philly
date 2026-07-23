// Proxies the FAA NAS Status feed server-side. nasstatus.faa.gov sends no
// Access-Control-Allow-Origin header, so a direct browser fetch is always blocked by CORS —
// the client previously routed through the same third-party CORS proxy chain used for SEPTA
// (allorigins.win/corsproxy.io/api.codetabs.com), all three of which are confirmed down or
// rate-limited (corsproxy.io now requires a paid plan for this kind of use, allorigins and
// codetabs return Cloudflare 522, confirmed via direct curl) — same root cause already fixed
// for SEPTA in api/septa.js. A first-party serverless proxy has no CORS restriction at all,
// so it needs none of that.
export default async function handler(req, res) {
  try {
    const response = await fetch('https://nasstatus.faa.gov/api/airport-status-information', {
      headers: { Accept: 'application/xml, text/xml, */*' },
    });
    if (!response.ok) throw new Error(`FAA NAS Status request failed: HTTP ${response.status}`);

    const text = await response.text();
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(200).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
