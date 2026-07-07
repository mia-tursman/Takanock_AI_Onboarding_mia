export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question, answer } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Missing question' });

  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE = process.env.AIRTABLE_FAQ_TABLE || 'Help Bot Questions';
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;

  try {
    // Step 1: fetch all existing canonical topics so Haiku can reuse one instead of coining a near-duplicate
    const listRes = await fetch(airtableUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    if (!listRes.ok) {
      const detail = await listRes.text();
      console.error('Airtable list failed:', listRes.status, detail);
      return res.status(500).json({ error: 'Airtable list failed', detail });
    }
    const listData = await listRes.json();
    const existingTopics = (listData.records || []).map(r => r.fields.Question).filter(Boolean);

    // Step 2: match the question to an existing topic (or propose a new one) using Haiku (fast + cheap)
    const normRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 40,
        system: 'You match user questions to a canonical FAQ topic. You will be given a new user question and a list of existing canonical topics. Err on the side of matching — if the new question is asking about the same general subject as an existing topic, even with different specific wording, treat it as a match. For example, \'MCP Server Options And Features\' and \'What MCPs Exist For Our Use\' are the SAME topic (both about available MCP connectors) and should match. Only propose a new topic if the subject matter is genuinely different, not just differently worded. If there\'s a match, respond with that EXISTING topic\'s text EXACTLY as given — do not alter it. If the new question is not a genuine question or help request (greetings, small talk, thanks, test messages), respond with exactly: SKIP. Otherwise respond with a new short canonical topic (5-8 words, title case, no punctuation). Respond with ONLY the topic text or SKIP, nothing else.',
        messages: [{ role: 'user', content: `Existing topics:\n${existingTopics.map(t => `- ${t}`).join('\n') || '(none yet)'}\n\nNew question: ${question}` }]
      })
    });
    const normData = await normRes.json();
    const canonical = (normData.content?.[0]?.text || question).trim().slice(0, 120);

    // Skip non-questions (greetings, small talk, etc.) — don't write them to Airtable
    if (canonical.toUpperCase() === 'SKIP') {
      return res.status(200).json({ skipped: true });
    }

    // Step 3: look for an existing record with this canonical topic
    const escaped = canonical.replace(/'/g, "\\'");
    const searchRes = await fetch(
      `${airtableUrl}?filterByFormula=${encodeURIComponent(`{Question} = '${escaped}'`)}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } }
    );
    if (!searchRes.ok) {
      const detail = await searchRes.text();
      console.error('Airtable search failed:', searchRes.status, detail);
      return res.status(500).json({ error: 'Airtable search failed', detail });
    }
    const searchData = await searchRes.json();
    const existing = searchData.records?.[0];
    const today = new Date().toISOString().split('T')[0];

    if (existing) {
      const newCount = (existing.fields.Count || 1) + 1;
      const updateRes = await fetch(`${airtableUrl}/${existing.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { Count: newCount, 'Is FAQ': newCount >= 3, 'Last Asked': today, Answer: answer } })
      });
      if (!updateRes.ok) {
        const detail = await updateRes.text();
        console.error('Airtable update failed:', updateRes.status, detail);
        return res.status(500).json({ error: 'Airtable update failed', detail });
      }
      return res.status(200).json({ canonical, count: newCount, isFaq: newCount >= 3 });
    } else {
      const createRes = await fetch(airtableUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { Question: canonical, Count: 1, 'Is FAQ': false, 'Last Asked': today, Answer: answer } })
      });
      if (!createRes.ok) {
        const detail = await createRes.text();
        console.error('Airtable create failed:', createRes.status, detail);
        return res.status(500).json({ error: 'Airtable create failed', detail });
      }
      return res.status(200).json({ canonical, count: 1, isFaq: false });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to log question' });
  }
}
