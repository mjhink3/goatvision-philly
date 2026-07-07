export default async function handler(req, res) {
  try {
    const now = new Date();
    const end = new Date(now.getTime() + 14 * 86400000);
    const fmt = d => d.toISOString().split('T')[0];

    const url = `https://app.ticketmaster.com/discovery/v2/events.json` +
      `?apikey=${process.env.TICKETMASTER_KEY}` +
      `&city=Philadelphia&stateCode=PA&radius=15&unit=miles` +
      `&size=50&sort=date,asc` +
      `&startDateTime=${fmt(now)}T00:00:00Z` +
      `&endDateTime=${fmt(end)}T23:59:59Z`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Ticketmaster request failed: HTTP ${response.status}`);

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
