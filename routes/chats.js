import express from "express";
import authMiddleware from "../middleware/auth.js";
import upload from "../utils/fileUpload.js";
import {
  verifyPasscode,
  setPasscode,
  getChatList,
  getChatMessages,
  sendChatMessage,
  markChatRead,
  forceSync,
  syncSessionChats,
  getChatProfilePicture,
  getBatchChatProfilePictures,
  deleteChatMessage,
  deleteChat,
  deleteMultipleChats,
  deleteMultipleMessages,
  togglePinChat,
  getChatNotes,
  addChatNote,
  deleteChatNote,
  getChatReminders,
  createChatReminder,
  deleteChatReminder,
  dismissChatReminder,
  reactToMessage,
  pinChatMessage,
  starChatMessage,
  sendPresenceUpdate,
  subscribeChatPresence,
  muteChat,
  archiveChat,
  setChatDisappearing,
  forwardChatMessage,
  checkNumbersOnWhatsApp,
  createOrUpdateChat,
} from "../controllers/chatController.js";

const router = express.Router();

router.use(authMiddleware);

// Passcode management
router.post("/passcode/verify", verifyPasscode);
router.post("/passcode/set",    setPasscode);

// Chat inbox — note: (.+) on :chatJid so Express doesn't truncate at the dot
// e.g. 918307418627@s.whatsapp.net  or  120363xxxxxx@g.us
router.get( "/:sessionId/list",                          getChatList);
router.get( "/:sessionId/messages/:chatJid(.+)",         getChatMessages);
router.get( "/:sessionId/avatar/:chatJid(.+)",           getChatProfilePicture);
router.post("/:sessionId/avatars-batch",                 getBatchChatProfilePictures);
router.post("/:sessionId/create-or-update-chat",          createOrUpdateChat);
router.post("/:sessionId/send",                          upload.single("file"), sendChatMessage);
router.post("/:sessionId/read/:chatJid(.+)",             markChatRead);
router.post("/:sessionId/pin/:chatJid(.+)",              togglePinChat);
router.post("/:sessionId/sync",                          syncSessionChats);
router.post("/:sessionId/force-sync",                    forceSync);
router.delete("/:sessionId/messages/:messageId",         deleteChatMessage);
router.delete("/:sessionId/chat/:chatJid(.+)",           deleteChat);
router.post("/:sessionId/chats/batch-delete",            deleteMultipleChats);
router.post("/:sessionId/messages/batch-delete",         deleteMultipleMessages);

// Advance Baileys Chat Interactions
router.post("/:sessionId/react",                         reactToMessage);
router.post("/:sessionId/pin-message",                   pinChatMessage);
router.post("/:sessionId/star-message",                  starChatMessage);
router.post("/:sessionId/presence",                      sendPresenceUpdate);
router.post("/:sessionId/subscribe-presence/:chatJid(.+)", subscribeChatPresence);
router.post("/:sessionId/mute/:chatJid(.+)",             muteChat);
router.post("/:sessionId/archive/:chatJid(.+)",          archiveChat);
router.post("/:sessionId/disappearing/:chatJid(.+)",     setChatDisappearing);
router.post("/:sessionId/forward",                       forwardChatMessage);
router.post("/:sessionId/check-whatsapp",                checkNumbersOnWhatsApp);

// Notes routes
router.get( "/:sessionId/notes/:chatJid(.+)",            getChatNotes);
router.post("/:sessionId/notes/:chatJid(.+)",            addChatNote);
router.delete("/:sessionId/notes/:noteId",               deleteChatNote);

// Reminders / Alerts routes
router.get( "/:sessionId/reminders/:chatJid(.+)",        getChatReminders);
router.post("/:sessionId/reminders/:chatJid(.+)",        upload.single("file"), createChatReminder);
router.delete("/:sessionId/reminders/:reminderId",       deleteChatReminder);
router.post("/:sessionId/reminders/:reminderId/dismiss", dismissChatReminder);

export default router;
