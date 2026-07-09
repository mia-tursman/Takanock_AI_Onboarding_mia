const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'for', 'our', 'your', 'and', 'of', 'in', 'on', 'is', 'are', 'do', 'i', 'how', 'what', 'does']);

function wordOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w && !STOPWORDS.has(w)));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w && !STOPWORDS.has(w)));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const [smaller, larger] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  let intersection = 0;
  for (const w of smaller) if (larger.has(w)) intersection++;
  return intersection / smaller.size;
}

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
        system: 'You normalize user questions into a short canonical topic (5-8 words, title case, no punctuation) so similar phrasings map to the same string. Example: "how do i download cowork" and "where do i get cowork" should both become "How To Install Cowork". If the input is NOT a genuine question or help request — greetings like "hello", small talk, "thanks", "test", or anything with no real informational content — respond with exactly: SKIP. Otherwise respond with ONLY the canonical topic, nothing else.',
        messages: [{ role: 'user', content: question }]
      })
    });
    const normData = await normRes.json();
    const canonical = (normData.content?.[0]?.text || question).trim().slice(0, 120);

    // Skip non-questions (greetings, small talk, etc.) — don't write them to Airtable
    if (canonical.toUpperCase() === 'SKIP') {
      return res.status(200).json({ skipped: true });
    }

    // Step 2: fetch all existing topics and compare via word overlap instead of asking the model to judge matches
    const listRes = await fetch(`${airtableUrl}?fields%5B%5D=Question&fields%5B%5D=Count`, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });
    if (!listRes.ok) {
      const detail = await listRes.text();
      console.error('Airtable list failed:', listRes.status, detail);
      return res.status(500).json({ error: 'Airtable list failed', detail });
    }
    const listData = await listRes.json();

    let existing = null;
    let bestScore = 0;
    for (const record of listData.records || []) {
      const topic = record.fields.Question;
      if (!topic) continue;
      const score = wordOverlap(canonical, topic);
      if (score >= 0.5 && score > bestScore) {
        bestScore = score;
        existing = record;
      }
    }

    const today = new Date().toISOString().split('T')[0];

    if (existing) {
      const matchedTopic = existing.fields.Question;
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
      return res.status(200).json({ canonical: matchedTopic, count: newCount, isFaq: newCount >= 3 });
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
