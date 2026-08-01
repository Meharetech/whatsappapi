import Flow from "../models/Flow.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import mongoose from "mongoose";

function normalizeGraphValue(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

// Get all flows for user
export const getFlows = async (req, res) => {
  try {
    const userId = req.user._id;
    const flows = await Flow.find({ userId })
      .populate("sessionId", "name phoneNumber status")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      flows,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get single flow by ID
export const getFlow = async (req, res) => {
  try {
    const { flowId } = req.params;
    const userId = req.user._id;

    const flow = await Flow.findOne({
      _id: new mongoose.Types.ObjectId(flowId),
      userId,
    }).populate("sessionId", "name phoneNumber status");

    if (!flow) {
      return res.status(404).json({
        success: false,
        message: "Flow not found",
      });
    }

    res.status(200).json({
      success: true,
      flow,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Create new flow
export const createFlow = async (req, res) => {
  try {
    const userId = req.user._id;
    const { name, description, status, sessionId } = req.body;
    const nodes = normalizeGraphValue(req.body.nodes);
    const edges = normalizeGraphValue(req.body.edges);

    // Verify session exists and belongs to user
    let session;
    try {
      session = await WhatsAppSession.findOne({
        _id: new mongoose.Types.ObjectId(sessionId),
        userId,
      });
    } catch (e) {
      // If sessionId is not a valid ObjectId, try finding by sessionId field
      session = await WhatsAppSession.findOne({
        sessionId: sessionId,
        userId,
      });
    }

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "WhatsApp session not found",
      });
    }

    const flow = new Flow({
      userId,
      sessionId: session._id,
      name,
      description,
      status,
      nodes: nodes || [],
      edges: edges || [],
    });

    await flow.save();
    await flow.populate("sessionId", "name phoneNumber status");

    res.status(201).json({
      success: true,
      message: "Flow created successfully",
      flow,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Update flow
export const updateFlow = async (req, res) => {
  try {
    const { flowId } = req.params;
    const userId = req.user._id;
    const { name, description, status, sessionId: newSessionId } = req.body;
    const nodes =
      req.body.nodes !== undefined
        ? normalizeGraphValue(req.body.nodes)
        : undefined;
    const edges =
      req.body.edges !== undefined
        ? normalizeGraphValue(req.body.edges)
        : undefined;

    const flow = await Flow.findOne({
      _id: new mongoose.Types.ObjectId(flowId),
      userId,
    });
    if (!flow) {
      return res.status(404).json({
        success: false,
        message: "Flow not found",
      });
    }

    if (name) flow.name = name;
    if (description) flow.description = description;
    if (status) flow.status = status;
    if (nodes) flow.nodes = nodes;
    if (edges) flow.edges = edges;

    if (newSessionId) {
      let session;
      try {
        session = await WhatsAppSession.findOne({
          _id: new mongoose.Types.ObjectId(newSessionId),
          userId,
        });
      } catch {
        session = await WhatsAppSession.findOne({ sessionId: newSessionId, userId });
      }
      if (!session) {
        return res.status(404).json({ success: false, message: "WhatsApp session not found" });
      }
      flow.sessionId = session._id;
    }

    await flow.save();
    await flow.populate("sessionId", "name phoneNumber status");

    res.status(200).json({
      success: true,
      message: "Flow updated successfully",
      flow,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

// Delete flow
export const deleteFlow = async (req, res) => {
  try {
    const { flowId } = req.params;
    const userId = req.user._id;

    const flow = await Flow.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(flowId),
      userId,
    });
    if (!flow) {
      return res.status(404).json({
        success: false,
        message: "Flow not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Flow deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get user's WhatsApp sessions (for flow creation)
export const getSessions = async (req, res) => {
  try {
    const userId = req.user._id;

    const sessions = await WhatsAppSession.find({ userId }).select(
      "name phoneNumber status",
    );

    res.status(200).json({
      success: true,
      sessions,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
