// /api/solve.js
// এই ফাইলটা তোমার project এর root এ "api" ফোল্ডার বানিয়ে তার ভিতরে রাখতে হবে
// path হবে: api/solve.js

import { createClient } from '@supabase/supabase-js';

// Supabase admin client (service_role key দিয়ে — এটা গোপন, leak হলে বিপদ)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // শুধু POST request নেওয়া হবে
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { parts, userApiKey, topic, isImage } = req.body;

  if (!parts || !Array.isArray(parts)) {
    return res.status(400).json({ error: 'Invalid request: parts missing' });
  }

  let apiKeyToUse = null;
  let usedAdminKey = false;
  let adminKeyRecord = null;

  // ── ১. যদি student নিজের key দেয়, সেটাই ব্যবহার হবে ──
  if (userApiKey && userApiKey.trim().length > 10) {
    apiKeyToUse = userApiKey.trim();
  } else {
    // ── ২. না দিলে admin key pool থেকে একটা active, quota-available key খুঁজে বের করা ──
    const today = new Date().toISOString().split('T')[0];

    const { data: keys, error: fetchErr } = await supabase
      .from('admin_gemini_keys')
      .select('*')
      .eq('is_active', true)
      .order('daily_used', { ascending: true }); // সবচেয়ে কম ব্যবহার হওয়া key আগে

    if (fetchErr || !keys || keys.length === 0) {
      return res.status(503).json({
        error: 'এই মুহূর্তে কোনো ফ্রি API key পাওয়া যাচ্ছে না। নিজের Gemini API key যোগ করো, অথবা কিছুক্ষণ পর আবার চেষ্টা করো।'
      });
    }

    // প্রতিদিন reset লজিক — যদি last_reset_date আজকের তারিখ না হয়, তাহলে daily_used 0 করে দাও
    for (const k of keys) {
      if (k.last_reset_date !== today) {
        await supabase
          .from('admin_gemini_keys')
          .update({ daily_used: 0, last_reset_date: today })
          .eq('id', k.id);
        k.daily_used = 0;
      }
    }

    // quota-available প্রথম key বেছে নাও
    const availableKey = keys.find(k => k.daily_used < k.daily_limit);

    if (!availableKey) {
      return res.status(503).json({
        error: 'আজকের জন্য সব ফ্রি quota শেষ। নিজের Gemini API key যোগ করো অসীম ব্যবহারের জন্য, অথবা কাল আবার চেষ্টা করো।'
      });
    }

    apiKeyToUse = availableKey.api_key;
    usedAdminKey = true;
    adminKeyRecord = availableKey;
  }

  // ── Gemini API কল করা (with retry for busy errors) ──
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        await new Promise(r => setTimeout(r, 1500));
      }

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKeyToUse}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 65536 }
          })
        }
      );

      const data = await geminiRes.json();

      if (data.error) {
        lastError = data.error.message || 'Unknown error';
        const isBusy = /high demand|overloaded|503|UNAVAILABLE/i.test(lastError);
        if (isBusy && attempt < maxRetries) continue;

        // log failure
        await supabase.from('usage_logs').insert({
          used_admin_key: usedAdminKey,
          topic: topic || null,
          is_image: !!isImage,
          success: false,
          error_message: lastError
        });

        return res.status(500).json({ error: lastError });
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // ── সফল হলে admin key ব্যবহার হলে usage বাড়িয়ে দাও ──
      if (usedAdminKey && adminKeyRecord) {
        await supabase
          .from('admin_gemini_keys')
          .update({
            daily_used: adminKeyRecord.daily_used + 1,
            total_requests: (adminKeyRecord.total_requests || 0) + 1
          })
          .eq('id', adminKeyRecord.id);
      }

      // log success
      await supabase.from('usage_logs').insert({
        used_admin_key: usedAdminKey,
        topic: topic || null,
        is_image: !!isImage,
        success: true
      });

      return res.status(200).json({ text });

    } catch (e) {
      lastError = e.message || 'সংযোগে সমস্যা হয়েছে';
      if (attempt === maxRetries) {
        await supabase.from('usage_logs').insert({
          used_admin_key: usedAdminKey,
          topic: topic || null,
          is_image: !!isImage,
          success: false,
          error_message: lastError
        });
        return res.status(500).json({ error: lastError });
      }
    }
  }
}
