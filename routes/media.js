import express from "express";
import authMiddleware from "../middleware/auth.js";
import upload from "../utils/fileUpload.js";
import * as mediaController from "../controllers/mediaController.js";

const router = express.Router();

// Protect all routes with authentication
router.use(authMiddleware);

// Collection routes — named routes MUST come before /:id
router.get("/collections", mediaController.getCollections);
router.post("/bulk/delete", mediaController.deleteMultipleMedia);
router.post("/", mediaController.createCollection);
router.get("/", mediaController.getCollections);

// Parameterized collection routes
router.get("/:id", mediaController.getCollection);
router.put("/:id", mediaController.updateCollection);
router.delete("/:id", mediaController.deleteCollection);
router.put("/:id/rename", mediaController.renameCollection);

// Subcollection routes
router.post("/:id/subcollections", mediaController.addSubcollection);
router.put(
  "/:id/subcollections/:scId/rename",
  mediaController.renameSubcollection,
);
router.delete("/:id/subcollections/:scId", mediaController.deleteSubcollection);

// Media upload routes
router.post(
  "/:id/media",
  upload.single("file"),
  mediaController.uploadToCollection,
);
router.post(
  "/:id/subcollections/:scId/media",
  upload.single("file"),
  mediaController.uploadToSubcollection,
);

// Media delete routes
router.delete("/:id/media/:mediaId", mediaController.deleteMediaFromCollection);
router.delete(
  "/:id/subcollections/:scId/media/:mediaId",
  mediaController.deleteMediaFromSubcollection,
);

export default router;
