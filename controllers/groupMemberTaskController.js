import GroupMemberTaskService from "../services/GroupMemberTaskService.js";

export const createTask = async (req, res) => {
  try {
    const task = await GroupMemberTaskService.createTask(req.user._id, req.body);
    res.status(201).json({ success: true, data: task });
  } catch (err) {
    console.error("createTask error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export const listTasks = async (req, res) => {
  try {
    const tasks = await GroupMemberTaskService.listTasks(req.user._id);
    res.json({ success: true, data: tasks });
  } catch (err) {
    console.error("listTasks error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getTask = async (req, res) => {
  try {
    const task = await GroupMemberTaskService.getTask(req.user._id, req.params.id);
    res.json({ success: true, data: task });
  } catch (err) {
    console.error("getTask error:", err);
    res.status(404).json({ success: false, error: err.message });
  }
};

export const startTask = async (req, res) => {
  try {
    const task = await GroupMemberTaskService.startTask(req.user._id, req.params.id);
    res.json({ success: true, message: "Task started successfully", data: task });
  } catch (err) {
    console.error("startTask error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export const stopTask = async (req, res) => {
  try {
    const task = await GroupMemberTaskService.stopTask(req.user._id, req.params.id);
    res.json({ success: true, message: "Task stopped successfully", data: task });
  } catch (err) {
    console.error("stopTask error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export const resetFailedTask = async (req, res) => {
  try {
    const task = await GroupMemberTaskService.resetFailedMembers(req.user._id, req.params.id);
    res.json({ success: true, message: "Failed members reset to pending successfully", data: task });
  } catch (err) {
    console.error("resetFailedTask error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export const deleteTask = async (req, res) => {
  try {
    await GroupMemberTaskService.deleteTask(req.user._id, req.params.id);
    res.json({ success: true, message: "Task deleted successfully" });
  } catch (err) {
    console.error("deleteTask error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export const resolveInvite = async (req, res) => {
  try {
    const { sessionId, inviteUrl } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: "Please select a connected WhatsApp account first." });
    }
    if (!inviteUrl) {
      return res.status(400).json({ success: false, error: "WhatsApp group invite link or code is required." });
    }
    const info = await GroupMemberTaskService.resolveGroupInvite(req.user._id, sessionId, inviteUrl);
    res.json({ success: true, data: info });
  } catch (err) {
    console.error("resolveInvite error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export const getGroupParticipants = async (req, res) => {
  try {
    const { sessionId, groupJid, inviteUrl, autoJoin } = req.body;
    const result = await GroupMemberTaskService.getGroupParticipants(req.user._id, sessionId, {
      groupJid,
      inviteUrl,
      autoJoin: Boolean(autoJoin),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error("getGroupParticipants error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
};

export default {
  createTask,
  listTasks,
  getTask,
  startTask,
  stopTask,
  resetFailedTask,
  deleteTask,
  resolveInvite,
  getGroupParticipants,
};

