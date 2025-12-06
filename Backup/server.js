// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json());

// health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'AutoLife Gemini Image API' });
});

// เรียก Gemini แบบข้อความ ใช้ร่วมกันทุก Tools
app.post('/api/gemini-text', async (req, res) => {
  try {
    const { prompt, useSearch } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt (string) is required' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not set' });
    }

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
    };

    // ถ้าอยากให้บางกรณีใช้ Google Search Grounding
    if (useSearch) {
      payload.tools = [{ google_search: {} }];
    }

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
      + `?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      console.error('Gemini error:', data.error || data);
      return res.status(500).json({
        error: data.error?.message || 'Gemini API error',
      });
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return res.status(500).json({ error: 'No text returned from Gemini' });
    }

    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});


app.listen(PORT, () => {
  console.log(`✅ AutoLife backend listening on http://localhost:${PORT}`);
});
