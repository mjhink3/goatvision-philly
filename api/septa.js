// Proxies SEPTA's TrainView/Alerts endpoints server-side. SEPTA's API sends no
// Access-Control-Allow-Origin header, so a direct browser fetch is always blocked by CORS —
// the client previously routed through a chain of third-party CORS proxies
// (allorigins.win/corsproxy.io/api.codetabs.com), all three of which are currently down or
// rate-limited (corsproxy.io now requires a paid plan for this kind of use, confirmed via
// direct curl). A first-party serverless proxy has no CORS restriction at all, so it needs
// none of that.
const ALLOWED_REQ1 = new Set(['rr', 'mfl', 'bsl', 'nhsl']);

export default async function handler(req, res) {
  const { type, req1 } = req.query;
  let url;
  if (type === 'trainview') {
    url = 'https://www3.septa.org/api/TrainView/index.php';
  } else if (type === 'alerts' && ALLOWED_REQ1.has(req1)) {
    url = `https://www3.septa.org/api/Alerts/index.php?req1=${req1}`;
  } else {
    return res.status(400).json({ error: 'type must be "trainview" or "alerts" with a valid req1' });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`SEPTA request failed: HTTP ${response.status}`);

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
