export default async function handler(req, res) {
  try {
    const user = process.env.PENNDOT_USER;
    const pass = process.env.PENNDOT_PASS;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');

    const response = await fetch('https://eventsdata.dot.pa.gov/liveEvents', {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!response.ok) {
      throw new Error(`RCRS request failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    const values = (data.values || []).filter(v => v.countyName === 'PHILADELPHIA');

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
