import mediaMessageService from "../services/mediaMessageService.js";
import { sendSubscriptionError } from "../utils/subscription.js";

export const sendMediaMessage = async (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = body.sessionId || body.session;
    const phoneNumber = body.phoneNumber || body.to;
    const type = body.type || (body.media && body.media.type) || "text";
    const message = body.message || body.caption || body.media?.caption || "";
    const contactName = body.contactName || "";
    const media =
      body.media && typeof body.media === "object"
        ? body.media
        : {
            url: body.mediaUrl || body.url || "",
            caption: body.caption || "",
            filename: body.filename || "",
          };

    if (!sessionId || !phoneNumber) {
      return res.status(400).json({
        error: "session (or sessionId) and to (or phoneNumber) are required",
      });
    }

    const result = await mediaMessageService.sendMediaMessage({
      userId: req.user._id,
      sessionId,
      phoneNumber,
      type,
      message,
      contactName,
      media,
      file: req.file || null,
    });

    return res.json(result);
  } catch (err) {
    return sendSubscriptionError(res, err, "Failed to send media message");
  }
};

export default { sendMediaMessage };
