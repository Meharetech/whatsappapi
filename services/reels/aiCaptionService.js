import axios from "axios";
import OpenRouterSettings from "../../models/OpenRouterSettings.js";

// Cache for OpenRouter settings
let cachedSettings = null;

function stripCodeFences(text = "") {
  return String(text)
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}

function normalizeLine(value = "") {
  return String(value)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTitle(title = "") {
  let clean = normalizeLine(stripCodeFences(title))
    .replace(/^"|"$/g, "")
    .replace(/\s+-\s+part\s*\d+$/i, "")
    .replace(/^part\s*\d+\s*[:-]?\s*/i, "")
    .trim();

  if (!clean) return "";

  // Keep title concise and human-readable for reels.
  if (clean.length > 80) {
    clean = `${clean.slice(0, 77).trim()}...`;
  }

  return clean;
}

function parseCaptionPayload(rawText) {
  const cleaned = stripCodeFences(rawText);

  // 1) Direct JSON parse
  try {
    return JSON.parse(cleaned);
  } catch (e) {}

  // 2) Parse first JSON object block from mixed text
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {}
  }

  return null;
}

function sanitizeHashtags(hashtags, hashtagCount) {
  if (!Array.isArray(hashtags)) {
    return ["reels", "viral", "trending"].slice(0, hashtagCount);
  }

  const cleaned = hashtags
    .map((tag) =>
      String(tag || "")
        .replace(/^#/, "")
        .trim(),
    )
    .filter(Boolean);

  if (cleaned.length === 0) {
    return ["reels", "viral", "trending"].slice(0, hashtagCount);
  }

  return cleaned.slice(0, hashtagCount);
}

function buildDefaultTitle(campaignTitle, youtubeTitle) {
  const base = String(campaignTitle || youtubeTitle || "").trim();
  if (!base) return "new trending reel status";
  return normalizeTitle(`${base} reel status`) || "new trending reel status";
}

function normalizeCaptionResult({
  payload,
  fallbackText,
  campaignTitle,
  youtubeTitle,
  hashtagCount,
}) {
  const safeText = normalizeLine(stripCodeFences(fallbackText || ""));
  const title =
    normalizeTitle(payload?.title || "") ||
    buildDefaultTitle(campaignTitle, youtubeTitle);
  const hook =
    normalizeLine(payload?.hook || "") || "Watch till end for the full vibe.";
  const cta =
    normalizeLine(payload?.cta || "") || "Follow for more daily reel ideas.";
  const caption =
    normalizeLine(payload?.caption || "") ||
    (safeText
      ? safeText.slice(0, 220)
      : "Fresh reel drop. Save and share with friends.");
  const hashtags = sanitizeHashtags(payload?.hashtags, hashtagCount);

  return {
    title,
    hook,
    cta,
    caption,
    hashtags,
  };
}

/**
 * Fetch OpenRouter settings from database
 * Caches result for 5 minutes to reduce DB calls
 */
async function getOpenRouterSettings() {
  try {
    // Return cached if available
    if (
      cachedSettings &&
      cachedSettings.timestamp > Date.now() - 5 * 60 * 1000
    ) {
      return cachedSettings.data;
    }

    const settings =
      (await OpenRouterSettings.findOne({ key: "global" })) ||
      (await OpenRouterSettings.create({ key: "global" }));

    cachedSettings = {
      data: settings,
      timestamp: Date.now(),
    };

    console.log(`[🤖 AI] Loaded OpenRouter settings: model=${settings.model}`);
    return settings;
  } catch (err) {
    console.error(`[❌ AI] Failed to load OpenRouter settings:`, err);
    throw err;
  }
}

/**
 * Generate caption for a reel part using OpenRouter API
 * Includes retry logic for reliability
 */
export async function generateCaptionForPart({
  campaignTitle,
  youtubeTitle,
  index,
  tone,
  hashtagCount,
}) {
  const topic = String(campaignTitle || youtubeTitle || "").trim();
  const prompt = [
    "You are an expert Instagram Reels copywriter for Indian music/status content.",
    `Topic keywords: \"${topic}\"`,
    `Tone: ${tone}`,
    "Write natural, high-converting Hinglish/English copy.",
    "",
    "Hard rules:",
    "1) Return ONLY valid JSON (no markdown, no code block, no extra text).",
    "2) JSON keys must be exactly: title, hook, cta, caption, hashtags.",
    "3) title must be plain text, 5-10 words, keyword-focused, and must NOT contain: Part, Episode, Campaign, Vibes - Part 1.",
    "4) caption must be normal readable text, not JSON.",
    "5) hashtags must be an array of exactly requested count, lowercase words without # symbol.",
    `6) hashtags array size must be exactly ${hashtagCount}.`,
    "",
    "Example style for title:",
    "new punjabi song reel karan aujla status",
  ].join("\n");

  const settings = await getOpenRouterSettings();
  const apiKey = settings.apiKey || process.env.OPENROUTER_API_KEY;
  const model = settings.model || "openai/gpt-4o-mini";

  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not configured. Set OPENROUTER_API_KEY env var.",
    );
  }

  // CORRECT URL: openrouter.ai (not api.openrouter.ai)
  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

  // Retry logic - attempt up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(
        `[🤖 AI] Generating caption ${index} (attempt ${attempt}/3)...`,
      );

      const response = await axios.post(
        OPENROUTER_URL,
        {
          model,
          messages: [
            {
              role: "system",
              content:
                "Output must be strict JSON only. Never wrap output in markdown code fences.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 300,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          timeout: 60000,
        },
      );

      const text =
        response?.data?.choices?.[0]?.message?.content ||
        JSON.stringify(response.data);

      console.log(`[✅ AI] Caption generated (attempt ${attempt})`);

      const parsed = parseCaptionPayload(text);
      if (!parsed) {
        console.warn(
          `[⚠️ AI] Response was not valid JSON. Falling back to sanitized text output.`,
        );
      }

      return normalizeCaptionResult({
        payload: parsed,
        fallbackText: text,
        campaignTitle,
        youtubeTitle,
        hashtagCount,
      });
    } catch (err) {
      console.error(`[❌ AI] Attempt ${attempt} failed:`, err.message || err);

      // If last attempt, throw error
      if (attempt === 3) {
        throw new Error(
          `OpenRouter API failed after 3 attempts: ${err?.message || "Unknown error"}`,
        );
      }

      // Wait before retry (exponential backoff)
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[⏳ AI] Retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}
