import InstagramNotification from "../models/InstagramNotification.js";

/**
 * Fetch all notifications for the logged-in user
 * GET /instagram/db-notifications
 */
export const getNotifications = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const notifications = await InstagramNotification.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    const unreadCount = await InstagramNotification.countDocuments({
      userId,
      isRead: false,
    });

    res.json({
      success: true,
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch notifications",
    });
  }
};

/**
 * Get a specific notification
 * GET /instagram/db-notifications/:id
 */
export const getNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id || req.user.id;

    const notification = await InstagramNotification.findOne({
      _id: id,
      userId,
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: "Notification not found",
      });
    }

    res.json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error("Error fetching notification:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch notification",
    });
  }
};

/**
 * Create a new notification
 * POST /instagram/db-notifications
 */
export const createNotification = async (req, res) => {
  try {
    const { userId, type, message, userName, relatedContent, thumbnail } =
      req.body;

    if (!userId || !type || !message) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: userId, type, message",
      });
    }

    const notification = await InstagramNotification.create({
      userId,
      type,
      message,
      userName,
      relatedContent,
      thumbnail,
      isRead: false,
      isArchived: false,
    });

    res.status(201).json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error("Error creating notification:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create notification",
    });
  }
};

/**
 * Mark notification as read
 * PUT /instagram/db-notifications/:id/read
 */
export const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id || req.user.id;

    const notification = await InstagramNotification.findOneAndUpdate(
      { _id: id, userId },
      { isRead: true },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: "Notification not found",
      });
    }

    res.json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update notification",
    });
  }
};

/**
 * Mark notification as unread
 * PUT /instagram/db-notifications/:id/unread
 */
export const markAsUnread = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id || req.user.id;

    const notification = await InstagramNotification.findOneAndUpdate(
      { _id: id, userId },
      { isRead: false },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: "Notification not found",
      });
    }

    res.json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error("Error marking notification as unread:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update notification",
    });
  }
};

/**
 * Archive a notification
 * PUT /instagram/db-notifications/:id/archive
 */
export const archiveNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id || req.user.id;

    const notification = await InstagramNotification.findOneAndUpdate(
      { _id: id, userId },
      { isArchived: true },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: "Notification not found",
      });
    }

    res.json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error("Error archiving notification:", error);
    res.status(500).json({
      success: false,
      error: "Failed to archive notification",
    });
  }
};

/**
 * Delete a notification
 * DELETE /instagram/db-notifications/:id
 */
export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id || req.user.id;

    const notification = await InstagramNotification.findOneAndDelete({
      _id: id,
      userId,
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: "Notification not found",
      });
    }

    res.json({
      success: true,
      message: "Notification deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete notification",
    });
  }
};

/**
 * Mark all notifications as read
 * PUT /instagram/db-notifications/mark-all-as-read
 */
export const markAllAsRead = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    await InstagramNotification.updateMany({ userId }, { isRead: true });

    res.json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark all as read",
    });
  }
};

/**
 * Get unread notification count
 * GET /instagram/db-notifications/count/unread
 */
export const getUnreadCount = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const count = await InstagramNotification.countDocuments({
      userId,
      isRead: false,
    });

    res.json({
      success: true,
      unreadCount: count,
    });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch unread count",
    });
  }
};

export default {
  getNotifications,
  getNotification,
  createNotification,
  markAsRead,
  markAsUnread,
  archiveNotification,
  deleteNotification,
  markAllAsRead,
  getUnreadCount,
};
