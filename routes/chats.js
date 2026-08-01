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
router.post("/:sessionId/send",                          upload.single("file"), sendChatMessage);
router.post("/:sessionId/read/:chatJid(.+)",             markChatRead);
router.post("/:sessionId/force-sync",                    forceSync);

export default router;
