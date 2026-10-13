import {
  S_WHATSAPP_NET,
  OFFICIAL_BIZ_JID,
  SERVER_JID,
  PSA_WID,
  STORIES_JID,
  META_AI_JID,
  WAJIDDomains,
  getServerFromDomainType,
  jidEncode,
  jidDecode,
  areJidsSameUser,
  isJidMetaAI,
  isPnUser,
  isLidUser,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
  isHostedPnUser,
  isHostedLidUser,
  botRegexp,
  isJidBot,
  jidNormalizedUser,
  transferDevice,
} from "../utils/jidUtils.js";

export {
  S_WHATSAPP_NET,
  OFFICIAL_BIZ_JID,
  SERVER_JID,
  PSA_WID,
  STORIES_JID,
  META_AI_JID,
  WAJIDDomains,
  getServerFromDomainType,
  jidEncode,
  jidDecode,
  areJidsSameUser,
  isJidMetaAI,
  isPnUser,
  isLidUser,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
  isHostedPnUser,
  isHostedLidUser,
  botRegexp,
  isJidBot,
  jidNormalizedUser,
  transferDevice,
};

// WhatsApp standard native Meta AI bot identifiers
export const DEFAULT_META_AI_BOT_JID = "867051314767696@bot";
export const DEFAULT_META_AI_PERSONA_ID = "867051314767696$760019659443059";
export const META_AI_NORMALIZED_JID = "13135550002@s.whatsapp.net";

// Session-level cache of discovered official bot parameters
const botInfoCache = new Map();

/**
 * Checks whether a given JID belongs to Meta AI (either standard bot JID or contact alias)
 */
export function isMetaAiJid(jid) {
  if (!jid) return false;
  const str = String(jid).toLowerCase();
  return (
    isJidMetaAI(str) ||
    isJidBot(str) ||
    str.includes("13135550002") ||
    str.includes("867051314767696") ||
    str.endsWith("@bot")
  );
}

/**
 * Maps any variant of Meta AI JID (@bot, @c.us, @s.whatsapp.net) to the standard conversational thread JID
 */
export function getStandardMetaAiThreadJid() {
  return META_AI_NORMALIZED_JID;
}

/**
 * Query or retrieve the official Meta AI bot JID & Persona ID registered on this WhatsApp account
 */
export async function resolveMetaAiBot(sock, sessionId) {
  if (sessionId && botInfoCache.has(sessionId)) {
    return botInfoCache.get(sessionId);
  }

  let botJid = DEFAULT_META_AI_BOT_JID;
  let personaId = DEFAULT_META_AI_PERSONA_ID;

  if (sock && typeof sock.getBotListV2 === "function") {
    try {
      const bots = await sock.getBotListV2();
      if (Array.isArray(bots) && bots.length > 0) {
        const primaryBot = bots[0];
        if (primaryBot?.jid) {
          botJid = primaryBot.jid;
          personaId = primaryBot.personaId || personaId;
          console.log(`[Meta AI] Discovered native WhatsApp bot JID: ${botJid}, personaId: ${personaId}`);
        }
      }
    } catch (err) {
      console.warn("[Meta AI] getBotListV2 query error, using fallback bot JID:", err.message);
    }
  }

  const result = { jid: botJid, personaId };
  if (sessionId) {
    botInfoCache.set(sessionId, result);
  }
  return result;
}

/**
 * Record when WhatsApp real Meta AI delivers an incoming message
 */
export function recordIncomingMetaAiMessage(sessionId) {
  // Handled natively by WhatsApp socket
}

/**
 * Notification handler when user sends a message in Meta AI chat
 * (NO third-party LLM or OpenRouter API - real native WhatsApp bot interaction only)
 */
export async function onUserSentMessage(sessionId, userId, text, io) {
  // Real native WhatsApp Meta AI responds directly via Baileys socket.
  // No synthetic mock or 3rd-party API calls.
}

export default {
  META_AI_JID,
  META_AI_NORMALIZED_JID,
  DEFAULT_META_AI_BOT_JID,
  DEFAULT_META_AI_PERSONA_ID,
  isMetaAiJid,
  getStandardMetaAiThreadJid,
  resolveMetaAiBot,
  recordIncomingMetaAiMessage,
  onUserSentMessage,
};
