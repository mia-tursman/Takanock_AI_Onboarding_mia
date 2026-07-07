export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Missing question' });

  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE = process.env.AIRTABLE_FAQ_TABLE || 'Help Bot Questions';
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;

  try {
    // Step 1: normalize the question into a short canonical topic using Haiku (fast + cheap)
    const normRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 40,
        system: 'You normalize user questions into a short canonical topic (5-8 words, title case, no punctuation) so similar phrasings map to the same string. Example: "how do i download cowork" and "where do i get cowork" should both become "How To Install Cowork". Respond with ONLY the canonical topic, nothing else.',
        messages: [{ role: 'user', content: question }]
      })
    });
    const normData = await normRes.json();
    const canonical = (normData.content?.[0]?.text || question).trim().slice(0, 120);

    // Step 2: look for an existing record with this canonical topic
    const escaped = canonical.replace(/'/g, "\\'");
    const searchRes = await fetch(
      `${airtableUrl}?filterByFormula=${encodeURIComponent(`{Question} = '${escaped}'`)}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    const searchData = await searchRes.json();
    const existing = searchData.records?.[0];
    const today = new Date().toISOString().split('T')[0];

    if (existing) {
      const newCount = (existing.fields.Count || 1) + 1;
      await fetch(`${airtableUrl}/${existing.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { Count: newCount, 'Is FAQ': newCount >= 3, 'Last Asked': today } })
      });
      return res.status(200).json({ canonical, count: newCount, isFaq: newCount >= 3 });
    } else {
      await fetch(airtableUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { Question: canonical, Count: 1, 'Is FAQ': false, 'Last Asked': today } })
      });
      return res.status(200).json({ canonical, count: 1, isFaq: false });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to log question' });
  }
}
