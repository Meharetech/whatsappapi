import InstagramSession from "../instagram/models/InstagramSession.js";
import InstagramProcessedComment from "../instagram/models/InstagramProcessedComment.js";
import InstagramAiAgent from "../instagram/models/InstagramAiAgent.js";
import { generateAndPostReply } from "../instagram/controllers/instagramAiAgentController.js";

// GET /api/webhook - verification for Meta
export async function verifyWebhook(req, res) {
  try {
    const mode = req.query["hub.mode"] || req.query["mode"];
    const token = req.query["hub.verify_token"] || req.query["verify_token"];
    const challenge = req.query["hub.challenge"] || req.query["challenge"];

    if (
      mode === "subscribe" &&
      token === process.env.META_WEBHOOK_VERIFY_TOKEN
    ) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  } catch (err) {
    console.error("[webhook.verify]", err.message || err);
    return res.status(500).send("Server error");
  }
}

// POST /api/webhook - receives events from Meta
export async function receiveWebhook(req, res) {
  try {
    // Acknowledge immediately to Meta (Response-first pattern)
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    // If we cannot even acknowledge, return 500
    console.error("[webhook.receive:ack]", err.message || err);
    return res.status(500).send("Error");
  }

  // Process payload asynchronously
  (async function processPayload() {
    try {
      const body = req.body || {};
      if (!body.entry || !Array.isArray(body.entry)) return;

      for (const entry of body.entry) {
        // page or page id is usually in entry.id
        const pageId = entry.id || null;
        console.log(`[webhook] Processing entry with pageId=${pageId}`);

        // Try to find session mapping for this page/business account
        const session = pageId
          ? await InstagramSession.findOne({
              $or: [
                { "graph.facebookPageId": pageId },
                { "graph.instagramBusinessAccountId": pageId },
                { "graph.facebookUserId": pageId },
              ],
            }).lean()
          : null;

        console.log(
          `[webhook] Session lookup: found=${!!session}, userId=${session?.userId || "none"}`,
        );

        // iterate changes (Graph API structure)
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};

          // Heuristic: comment payloads have item==='comment' or verb==='add' or comment_id
          const isCommentEvent =
            value?.item === "comment" ||
            value?.verb === "add" ||
            !!value?.comment_id ||
            !!value?.id;
          if (!isCommentEvent) continue;

          // extract fields
          const commentId =
            value.comment_id || value.id || value?.comment?.id || null;
          const mediaId =
            value.media_id ||
            value?.media_id ||
            value?.parent_id ||
            value?.post_id ||
            null;
          const text =
            value.text || value.message || value?.comment?.text || null;
          const senderId =
            value.sender_id || value.from?.id || value?.from || null;
          const createdTime =
            value.created_time ||
            value.timestamp ||
            value?.comment?.timestamp ||
            null;

          console.log(
            `[webhook] Comment event: commentId=${commentId}, text="${text}", senderId=${senderId}`,
          );

          if (!commentId) continue; // nothing to do without a comment id

          // Determine agent/user context
          let agent = null;
          let userId = session?.userId || null;
          if (userId) {
            agent = await InstagramAiAgent.findOne({
              userId,
              isActive: true,
            }).lean();
            console.log(
              `[webhook] Agent lookup for userId=${userId}: found=${!!agent}, agentId=${agent?._id || "none"}`,
            );
          } else {
            console.warn(
              `[webhook] No session found for pageId=${pageId}, skipping comment ${commentId}`,
            );
          }

          // Deduplicate: check if comment already processed
          const exists = await InstagramProcessedComment.findOne({ commentId });
          if (exists) {
            console.log(`[webhook] Comment already processed: ${commentId}`);
            continue;
          }

          // If we have an agent and user, create a processing lock record to avoid races
          if (agent && userId) {
            try {
              await InstagramProcessedComment.create({
                userId,
                agentId: agent._id,
                commentId,
                mediaId: mediaId || "",
                username: String(senderId || "").toLowerCase(),
                commentText: text || "",
                status: "processing",
                processedAt: new Date(),
              });
              console.log(
                `[webhook] Created processing record: commentId=${commentId}, status=processing`,
              );
            } catch (err) {
              // duplicate key or other issue -> skip
              console.warn(
                `[webhook] processed record create failed: ${err.message || err}`,
              );
              continue;
            }
          } else {
            console.warn(
              `[webhook] No agent/user to process comment: commentId=${commentId}, agent=${!!agent}, userId=${userId}`,
            );
            continue;
          }

          // Build a mock request for existing handler so we reuse reply logic
          try {
            const mockReq = {
              user: { _id: userId },
              body: {
                commentId,
                mediaId,
                mediaCaption: "",
                mediaType: "",
                mediaUrl: "",
                likeCount: 0,
                commentsCount: 0,
                permalink: "",
                commentText: text,
                username: senderId,
              },
            };

            // fake response object - generateAndPostReply may call res.json
            let responseData = null;
            const mockRes = {
              status(code) {
                this._status = code;
                return this;
              },
              json(payload) {
                responseData = payload;
                console.log(
                  `[webhook.reply] ${commentId} -> status=${this._status}, success=${payload?.success}, reply="${payload?.data?.reply}"`,
                );
                return payload;
              },
              send() {
                return null;
              },
            };

            // Run in background via setTimeout to ensure proper async context
            setTimeout(async () => {
              try {
                console.log(
                  `[webhook.auto-reply] START: commentId=${commentId}, text="${text}", userId=${userId}, agentId=${agent?._id}`,
                );
                await generateAndPostReply(mockReq, mockRes);
                console.log(
                  `[webhook.auto-reply] SUCCESS: commentId=${commentId}, response=${JSON.stringify(responseData)}`,
                );
              } catch (err) {
                console.error(
                  `[webhook.auto-reply] ERROR: commentId=${commentId}`,
                  err.message || err,
                  err.stack,
                );
                // mark processed record as failed if present
                try {
                  if (agent && userId) {
                    const errorMsg =
                      err?.message || String(err) || "Unknown error";
                    await InstagramProcessedComment.updateOne(
                      { userId, agentId: agent._id, commentId },
                      {
                        $set: {
                          status: "failed",
                          error: errorMsg,
                          processedAt: new Date(),
                        },
                      },
                    );
                    console.log(
                      `[webhook.auto-reply] marked ${commentId} as failed: ${errorMsg}`,
                    );
                  }
                } catch (e) {
                  console.error(
                    "[webhook.auto-reply] failed to mark record as failed",
                    e.message,
                  );
                }
              }
            }, 100); // 100ms delay to ensure response to Meta is sent
          } catch (err) {
            console.error(
              "[webhook.process] failed to dispatch:",
              err.message || err,
            );
          }
        }
      }
    } catch (err) {
      console.error("[webhook.processPayload]", err.message || err);
    }
  })();
}
