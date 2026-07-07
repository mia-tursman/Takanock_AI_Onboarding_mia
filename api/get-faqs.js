export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE = process.env.AIRTABLE_FAQ_TABLE || 'Help Bot Questions';
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${encodeURIComponent('{Is FAQ} = TRUE()')}&sort[0][field]=Count&sort[0][direction]=desc`;

  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    const data = await response.json();
    const faqs = (data.records || []).map(r => ({ question: r.fields.Question, count: r.fields.Count, answer: r.fields.Answer }));
    res.status(200).json({ faqs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
}
