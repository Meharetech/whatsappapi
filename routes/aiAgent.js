import express from "express";
import authMiddleware from "../middleware/auth.js";
import OpenRouterSettings from "../models/OpenRouterSettings.js";
import AiKnowledgeSummary from "../models/AiKnowledgeSummary.js";
import AiAgent from "../models/AiAgent.js";
import AiReplyLog from "../models/AiReplyLog.js";
import { WhatsAppSession } from "../models/index.js";

const router = express.Router();
router.use(authMiddleware);

// ── Summarize knowledge ─────────────────────────────────────────────────────
router.post("/knowledge/summarize", async (req, res) => {
  try {
    const { sourceType = "text", context = "" } = req.body || {};

    if (!["text", "file"].includes(sourceType))
      return res
        .status(400)
        .json({ success: false, error: "Invalid sourceType" });

    const rawContext = String(context || "").trim();
    if (!rawContext)
      return res
        .status(400)
        .json({ success: false, error: "Context is required" });

    const limitedLines = rawContext
      .split(/\r?\n/)
      .slice(0, 100)
      .map((l) => l.trimEnd())
      .join("\n")
      .trim();

    const settings = await OpenRouterSettings.findOne({ key: "global" }).lean();
    if (!settings?.apiKey)
      return res
        .status(400)
        .json({
          success: false,
          error: "OpenRouter API key not configured by admin",
        });

    const model = settings.model || "openai/gpt-4o-mini";
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content:
              "Create an exhaustive and detailed business brief based on the provided info. Include every specific detail about: services offered, full pricing structures, contact information (phones, emails, links), return/shipping policies, business hours, and brand personality. Do not be overly concise — be comprehensive so the AI agent has all the facts to answer any customer question accurately.",
          },
          {
            role: "user",
            content: `Summarize this company info:\n\n${limitedLines}`,
          },
        ],
      }),
    });

    const data = await resp.json();
    if (!resp.ok)
      return res
        .status(502)
        .json({
          success: false,
          error: data?.error?.message || "OpenRouter request failed",
        });

    const summary = (data?.choices?.[0]?.message?.content || "").trim();
    if (!summary)
      return res
        .status(502)
        .json({ success: false, error: "No summary returned" });

    const lineCount = limitedLines.split(/\r?\n/).length;
    const saved = await AiKnowledgeSummary.create({
      userId: req.user._id,
      sourceType,
      contextLineCount: lineCount,
      contextPreview: limitedLines.slice(0, 4000),
      summary,
      model,
      openRouterSettingsId: settings._id,
    });

    return res.json({
      success: true,
      data: {
        summary,
        summaryId: saved._id,
        model,
        contextLineCount: lineCount,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── List user's agents ─────────────────────────────────────────────────────
router.get("/agents", async (req, res) => {
  try {
    const agents = await AiAgent.find({ userId: req.user._id })
      .populate("knowledgeSummaryId", "summary contextPreview model createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // Attach session details
    const sessionIds = agents.map((a) => a.sessionId);
    const sessions = await WhatsAppSession.find({
      sessionId: { $in: sessionIds },
    })
      .select("sessionId name phoneNumber status")
      .lean();
    const sessMap = {};
    sessions.forEach((s) => {
      sessMap[s.sessionId] = s;
    });

    const rows = agents.map((a) => ({
      ...a,
      session: sessMap[a.sessionId] || null,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get single agent ───────────────────────────────────────────────────────
router.get("/agents/:id", async (req, res) => {
  try {
    const agent = await AiAgent.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
      .populate("knowledgeSummaryId", "summary contextPreview model createdAt")
      .lean();
    if (!agent)
      return res.status(404).json({ success: false, error: "Agent not found" });
    const session = await WhatsAppSession.findOne({
      sessionId: agent.sessionId,
    })
      .select("sessionId name phoneNumber status")
      .lean();
    res.json({ success: true, data: { ...agent, session: session || null } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get reply logs for an agent ───────────────────────────────────────────
router.get("/agents/:id/replies", async (req, res) => {
  try {
    const agent = await AiAgent.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();
    if (!agent)
      return res.status(404).json({ success: false, error: "Agent not found" });
    const logs = await AiReplyLog.find({ agentId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Create / update agent (upsert by sessionId) ─────────────────────────────
router.post("/agents", async (req, res) => {
  try {
    const { sessionId, agentName, knowledgeSummaryId, config } = req.body;
    if (!sessionId)
      return res
        .status(400)
        .json({ success: false, error: "sessionId required" });

    // Verify session belongs to user
    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    const agent = await AiAgent.findOneAndUpdate(
      { userId: req.user._id, sessionId },
      {
        $set: {
          agentName: agentName || "AI Auto-Reply Agent",
          isActive: true,
          ...(knowledgeSummaryId ? { knowledgeSummaryId } : {}),
          ...(config ? { config } : {}),
        },
      },
      { upsert: true, new: true, runValidators: true },
    );

    res.json({ success: true, data: agent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Change session linked to agent ─────────────────────────────────────────
router.patch("/agents/:id/session", async (req, res) => {
  try {
    const { newSessionId } = req.body;
    if (!newSessionId)
      return res
        .status(400)
        .json({ success: false, error: "newSessionId required" });

    const session = await WhatsAppSession.findOne({
      sessionId: newSessionId,
      userId: req.user._id,
    });
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    // Prevent linking to a session that already has a different agent
    const conflict = await AiAgent.findOne({
      userId: req.user._id,
      sessionId: newSessionId,
    });
    if (conflict && conflict._id.toString() !== req.params.id) {
      return res
        .status(409)
        .json({
          success: false,
          error: "Another agent is already assigned to that session",
        });
    }

    const agent = await AiAgent.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { sessionId: newSessionId } },
      { new: true },
    );
    if (!agent)
      return res.status(404).json({ success: false, error: "Agent not found" });

    res.json({ success: true, data: agent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Toggle active ──────────────────────────────────────────────────────────
router.patch("/agents/:id/toggle", async (req, res) => {
  try {
    const agent = await AiAgent.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!agent)
      return res.status(404).json({ success: false, error: "Agent not found" });
    agent.isActive = !agent.isActive;
    await agent.save();
    res.json({ success: true, data: { isActive: agent.isActive } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Delete agent ───────────────────────────────────────────────────────────
router.delete("/agents/:id", async (req, res) => {
  try {
    const deleted = await AiAgent.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!deleted)
      return res.status(404).json({ success: false, error: "Agent not found" });
    res.json({ success: true, message: "Agent deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Test chat (uses real OpenRouter + knowledge summary) ────────────────────
router.post("/test-chat", async (req, res) => {
  try {
    const { message, agentId, summaryId } = req.body;
    if (!message)
      return res
        .status(400)
        .json({ success: false, error: "message required" });

    const settings = await OpenRouterSettings.findOne({ key: "global" }).lean();
    if (!settings?.apiKey)
      return res
        .status(400)
        .json({ success: false, error: "OpenRouter API key not configured" });

    // Get summary
    let summaryText = "";
    const sid =
      summaryId ||
      (agentId
        ? (await AiAgent.findOne({ _id: agentId, userId: req.user._id }).lean())
            ?.knowledgeSummaryId
        : null);
    if (sid) {
      const ks = await AiKnowledgeSummary.findOne({
        _id: sid,
        userId: req.user._id,
      }).lean();
      if (ks?.summary) summaryText = ks.summary;
    }

    const systemPrompt = summaryText
      ? `You are a customer support AI assistant representing the business described below. You speak on behalf of this business — when someone asks "your name", "who are you", or similar, answer using the name and details from the business info below.\n\nBusiness info:\n${summaryText}\n\nRules:\n- Answer questions using only the business info above.\n- Speak as a representative of this business (use "we" or give direct answers from the info).\n- If a question cannot be answered from the info above, say: "Please contact support."\n- Be concise and friendly.`
      : "You are a helpful AI customer support agent. Be concise and friendly.";

    const model = settings.model || "openai/gpt-4o-mini";
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 200,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
      }),
    });

    const data = await resp.json();
    if (!resp.ok)
      return res
        .status(502)
        .json({
          success: false,
          error: data?.error?.message || "OpenRouter error",
        });

    const reply = (data?.choices?.[0]?.message?.content || "").trim();
    res.json({ success: true, data: { reply, model } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get Global AI Status ─────────────────────────────────────────────────────
router.get("/status", async (req, res) => {
  try {
    const settings = await OpenRouterSettings.findOne({ key: "global" }).lean();
    const agents = await AiAgent.find({ userId: req.user._id }).lean();
    
    // System is "Enabled" if at least one agent is enabled
    // Or if the last global command was "start"
    const isGlobalEnabled = agents.some(a => a.autoReplyEnabled);

    res.json({
      success: true,
      data: {
        configured: !!settings?.apiKey,
        model: settings?.model || "openai/gpt-4o-mini",
        isGlobalEnabled,
        agentCount: agents.length,
        activeAgents: agents.filter(a => a.autoReplyEnabled).length
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── Start auto-reply ───────────────────────────────────────────────────────
router.post("/start-auto-reply", async (req, res) => {
  try {
    await AiAgent.updateMany(
      { userId: req.user._id },
      {
        autoReplyEnabled: true,
        autoReplyStartedAt: new Date(),
      },
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Stop auto-reply ────────────────────────────────────────────────────────
router.post("/stop-auto-reply", async (req, res) => {
  try {
    await AiAgent.updateMany(
      { userId: req.user._id },
      {
        autoReplyEnabled: false,
        autoReplyStartedAt: null,
      },
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
