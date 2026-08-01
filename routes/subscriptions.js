import express from "express";
import authMiddleware from "../middleware/auth.js";
import subscriptionController from "../controllers/subscriptionController.js";

const router = express.Router();

router.get("/me", authMiddleware, subscriptionController.getMySubscription);
router.get("/plans", authMiddleware, subscriptionController.getAvailablePlans);
router.post("/switch", authMiddleware, subscriptionController.switchMyPlan);

router.get(
  "/admin/plans",
  authMiddleware,
  subscriptionController.getAdminPlans,
);
router.post(
  "/admin/plans",
  authMiddleware,
  subscriptionController.createAdminPlan,
);
router.put(
  "/admin/plans/:id",
  authMiddleware,
  subscriptionController.updateAdminPlan,
);
router.delete(
  "/admin/plans/:id",
  authMiddleware,
  subscriptionController.deleteAdminPlan,
);

router.get(
  "/admin/settings",
  authMiddleware,
  subscriptionController.getAdminSettings,
);
router.put(
  "/admin/settings",
  authMiddleware,
  subscriptionController.updateAdminSettings,
);

router.post(
  "/admin/assign",
  authMiddleware,
  subscriptionController.assignPlanToUser,
);
router.get(
  "/admin/users-usage",
  authMiddleware,
  subscriptionController.getAdminUsersUsage,
);

export default router;
