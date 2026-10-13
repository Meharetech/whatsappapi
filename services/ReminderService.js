import { WaChatReminder } from "../models/index.js";
import WhatsAppService from "./WhatsAppService.js";
import CampaignService from "./CampaignService.js";
import { join } from "path";

class ReminderService {
  constructor() {
    this.intervalId = null;
  }

  start() {
    if (this.intervalId) return;
    console.log("[REMINDER SERVICE] Started background reminder scheduler tick (every 10s)");
    this.intervalId = setInterval(() => this.checkReminders(), 10 * 1000);
  }

  async checkReminders() {
    try {
      const now = new Date();
      const dueReminders = await WaChatReminder.find({
        isTriggered: false,
        remindAt: { $lte: now },
      });

      if (!dueReminders || dueReminders.length === 0) return;

      for (const reminder of dueReminders) {
        reminder.isTriggered = true;

        // Auto-send message or media to WhatsApp contact if enabled
        if (reminder.autoSend && !reminder.isSent) {
          try {
            console.log(`[REMINDER AUTO-SEND] Sending message/image to ${reminder.chatJid}`);
            
            let fullMediaPath = reminder.mediaUrl;
            if (fullMediaPath && fullMediaPath.startsWith("/uploads/")) {
              fullMediaPath = join(process.cwd(), fullMediaPath);
            }

            const sendResult = await CampaignService.sendSingleMessage(
              reminder.userId,
              reminder.sessionId,
              reminder.chatJid,
              reminder.sendText || reminder.reminderText || "",
              reminder.contactName || "",
              fullMediaPath || null,
              reminder.mediaType || null
            );

            if (sendResult?.success) {
              reminder.isSent = true;
              reminder.sentAt = new Date();
              console.log(`[REMINDER AUTO-SEND SUCCESS] Sent to ${reminder.chatJid}`);
            }
          } catch (autoErr) {
            console.error(`[REMINDER AUTO-SEND ERROR] Failed to send to ${reminder.chatJid}:`, autoErr.message);
            reminder.sendError = autoErr.message;
          }
        }

        await reminder.save();

        const payload = {
          reminderId: reminder._id,
          sessionId: reminder.sessionId,
          chatJid: reminder.chatJid,
          contactName: reminder.contactName || "",
          phoneNumber: reminder.phoneNumber || "",
          reminderText: reminder.reminderText,
          remindAt: reminder.remindAt,
          autoSend: !!reminder.autoSend,
          isSent: !!reminder.isSent,
          sendText: reminder.sendText || "",
          mediaUrl: reminder.mediaUrl || "",
        };

        console.log(`[REMINDER ALERT] Triggering alert for ${reminder.chatJid} - "${reminder.reminderText}"`);

        // Realtime Socket.IO emission to browser for alert pop-up
        if (WhatsAppService.io) {
          WhatsAppService.io.to(reminder.sessionId).emit("chat:reminder_alert", payload);
          if (reminder.userId) {
            WhatsAppService.io.to(`user:${reminder.userId.toString()}`).emit("chat:reminder_alert", payload);
          }
        }
      }
    } catch (err) {
      console.error("[REMINDER SERVICE ERROR]", err.message);
    }
  }
}

const reminderService = new ReminderService();
export default reminderService;
