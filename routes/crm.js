import express from "express";
import authMiddleware from "../middleware/auth.js";
import {
  listContacts,
  getCrmStats,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  bulkDeleteContacts,
  deleteAllContacts,
  bulkUpdateContacts,
  addContactNote,
  deleteContactNote,
  importFromChats,
  exportContacts,
} from "../controllers/crmController.js";

const router = express.Router();

// All CRM routes are authenticated
router.use(authMiddleware);

// Analytics & Bulk actions
router.get("/stats", getCrmStats);
router.get("/export", exportContacts);
router.post("/import-from-chats", importFromChats);
router.post("/contacts/bulk-delete", bulkDeleteContacts);
router.post("/contacts/delete-all", deleteAllContacts);
router.post("/contacts/bulk-update", bulkUpdateContacts);

// Contact CRUD
router.get("/contacts", listContacts);
router.post("/contacts", createContact);
router.get("/contacts/:id", getContact);
router.put("/contacts/:id", updateContact);
router.delete("/contacts/:id", deleteContact);

// Notes Sub-resource
router.post("/contacts/:id/notes", addContactNote);
router.delete("/contacts/:id/notes/:noteId", deleteContactNote);

export default router;
