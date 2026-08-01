import express from "express";
import instagramNotificationController from "../controllers/instagramNotificationController.js";
import authMiddleware from "../../middleware/auth.js";

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * @route   GET /count/unread
 * @desc    Get unread notification count
 * @access  Private
 */
router.get("/count/unread", instagramNotificationController.getUnreadCount);

/**
 * @route   PUT /mark-all-as-read
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.put("/mark-all-as-read", instagramNotificationController.markAllAsRead);

/**
 * @route   GET /
 * @desc    Get all notifications for the user
 * @access  Private
 */
router.get("/", instagramNotificationController.getNotifications);

/**
 * @route   POST /
 * @desc    Create a new notification
 * @access  Private
 */
router.post("/", instagramNotificationController.createNotification);

/**
 * @route   GET /:id
 * @desc    Get a specific notification
 * @access  Private
 */
router.get("/:id", instagramNotificationController.getNotification);

/**
 * @route   PUT /:id/read
 * @desc    Mark notification as read
 * @access  Private
 */
router.put("/:id/read", instagramNotificationController.markAsRead);

/**
 * @route   PUT /:id/unread
 * @desc    Mark notification as unread
 * @access  Private
 */
router.put("/:id/unread", instagramNotificationController.markAsUnread);

/**
 * @route   PUT /:id/archive
 * @desc    Archive a notification
 * @access  Private
 */
router.put("/:id/archive", instagramNotificationController.archiveNotification);

/**
 * @route   DELETE /:id
 * @desc    Delete a notification
 * @access  Private
 */
router.delete("/:id", instagramNotificationController.deleteNotification);

export default router;
