import User from "../models/User.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import SubscriptionSettings from "../models/SubscriptionSettings.js";
import UserSubscription from "../models/UserSubscription.js";
import SubscriptionService from "../services/SubscriptionService.js";

function isAdmin(user) {
  return user?.role === "admin" || user?.role === "superadmin";
}

function ensureAdmin(req, res) {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

export const getMySubscription = async (req, res) => {
  try {
    const summary = await SubscriptionService.getUsageSummary(req.user._id);
    const settings = await SubscriptionService.getSettings();

    res.json({
      success: true,
      data: {
        ...summary,
        allowUserPlanSwitch: !!settings?.allowUserPlanSwitch,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getAvailablePlans = async (req, res) => {
  try {
    const plans = await SubscriptionService.getAvailablePlansForUser(req.user);
    res.json({
      success: true,
      data: plans.map((p) => SubscriptionService.toClientPlan(p)),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const switchMyPlan = async (req, res) => {
  try {
    const settings = await SubscriptionService.getSettings();
    if (!settings?.allowUserPlanSwitch) {
      return res
        .status(403)
        .json({ success: false, error: "Plan switching is disabled by admin" });
    }

    const { planId } = req.body;
    if (!planId) {
      return res
        .status(400)
        .json({ success: false, error: "planId is required" });
    }

    const plan = await SubscriptionPlan.findById(planId);
    if (!plan || !plan.isActive) {
      return res
        .status(404)
        .json({ success: false, error: "Plan not found or inactive" });
    }
    if (!SubscriptionService.isPlanEligibleForUser(plan, req.user)) {
      return res.status(403).json({
        success: false,
        error: "This plan is not available for your role or location",
      });
    }

    // Block downgrade: paid active → free/demo
    const currentSub = await SubscriptionService.getUserSubscription(
      req.user._id,
    );
    if (currentSub?.planId) {
      const cp = currentSub.planId;
      const currentPrice = (cp.priceMonthly || 0) + (cp.priceYearly || 0);
      const newPrice = (plan.priceMonthly || 0) + (plan.priceYearly || 0);
      if (
        currentPrice > 0 &&
        newPrice === 0 &&
        currentSub.status === "active"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "You cannot switch to a free/demo plan while your paid plan is active.",
        });
      }
    }

    const sub = await SubscriptionService.assignPlanToUser(
      req.user._id,
      planId,
    );

    res.json({
      success: true,
      message: `Switched to ${sub.planId.name}`,
      data: {
        subscription: {
          status: sub.status,
          startedAt: sub.startedAt,
          expiresAt: sub.expiresAt,
        },
        plan: SubscriptionService.toClientPlan(sub.planId),
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

export const getAdminPlans = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const plans = await SubscriptionPlan.find({}).sort({
      sortOrder: 1,
      createdAt: 1,
    });
    res.json({
      success: true,
      data: plans.map((p) => SubscriptionService.toClientPlan(p)),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const createAdminPlan = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const payload = req.body || {};
    if (!payload.name || !payload.slug) {
      return res
        .status(400)
        .json({ success: false, error: "name and slug are required" });
    }

    const plan = await SubscriptionPlan.create({
      ...payload,
      slug: String(payload.slug).toLowerCase().trim(),
      features: Array.isArray(payload.features) ? payload.features : [],
    });

    res.status(201).json({
      success: true,
      data: SubscriptionService.toClientPlan(plan),
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

export const updateAdminPlan = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { id } = req.params;
    const payload = { ...req.body };
    if (payload.slug) {
      payload.slug = String(payload.slug).toLowerCase().trim();
    }

    const plan = await SubscriptionPlan.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    if (!plan) {
      return res.status(404).json({ success: false, error: "Plan not found" });
    }

    res.json({ success: true, data: SubscriptionService.toClientPlan(plan) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

export const deleteAdminPlan = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { id } = req.params;
    const usageCount = await UserSubscription.countDocuments({ planId: id });

    if (usageCount > 0) {
      await SubscriptionPlan.findByIdAndUpdate(
        id,
        { isActive: false },
        { new: true },
      );
      return res.json({
        success: true,
        message:
          "Plan is in use by users, so it was disabled instead of deleted.",
      });
    }

    await SubscriptionPlan.findByIdAndDelete(id);
    res.json({ success: true, message: "Plan deleted" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

export const getAdminSettings = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const settings = await SubscriptionSettings.findOne({ key: "global" })
      .populate("demoPlanId")
      .lean();
    if (!settings) return res.json({ success: true, data: null });

    // Mask secret — send only whether it's set, not the actual value
    const masked = {
      ...settings,
      razorpayKeySecret: settings.razorpayKeySecret
        ? "••••••••••••••••••••••••"
        : "",
      razorpayKeySecretSet: !!settings.razorpayKeySecret,
    };
    res.json({ success: true, data: masked });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const updateAdminSettings = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const payload = { ...req.body } || {};

    // Don't overwrite secret if the frontend sent back the masked placeholder
    if (
      payload.razorpayKeySecret &&
      payload.razorpayKeySecret.startsWith("•")
    ) {
      delete payload.razorpayKeySecret;
    }
    // Remove client-only field
    delete payload.razorpayKeySecretSet;

    const settings = await SubscriptionSettings.findOneAndUpdate(
      { key: "global" },
      payload,
      { new: true, upsert: true, runValidators: true },
    )
      .populate("demoPlanId")
      .lean();

    const masked = {
      ...settings,
      razorpayKeySecret: settings.razorpayKeySecret
        ? "••••••••••••••••••••••••"
        : "",
      razorpayKeySecretSet: !!settings.razorpayKeySecret,
    };
    res.json({ success: true, data: masked });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

export const assignPlanToUser = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const {
      userId,
      planId,
      durationDays,
      enforceEligibility = false,
    } = req.body;
    if (!userId || !planId) {
      return res
        .status(400)
        .json({ success: false, error: "userId and planId are required" });
    }

    if (enforceEligibility) {
      const [user, plan] = await Promise.all([
        User.findById(userId).lean(),
        SubscriptionPlan.findById(planId).lean(),
      ]);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }
      if (!plan || !plan.isActive) {
        return res
          .status(404)
          .json({ success: false, error: "Plan not found or inactive" });
      }
      if (!SubscriptionService.isPlanEligibleForUser(plan, user)) {
        return res.status(403).json({
          success: false,
          error: "Selected plan is not eligible for this user's role/location",
        });
      }
    }

    const sub = await SubscriptionService.assignPlanToUser(userId, planId, {
      durationDays,
    });
    const usageSummary = await SubscriptionService.getUsageSummary(userId);

    res.json({
      success: true,
      message: "Plan assigned successfully",
      data: {
        userId,
        subscription: {
          status: sub.status,
          startedAt: sub.startedAt,
          expiresAt: sub.expiresAt,
        },
        plan: SubscriptionService.toClientPlan(sub.planId),
        usage: usageSummary.usage,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

export const getAdminUsersUsage = async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const users = await User.find({}, "email name role createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const rows = await Promise.all(
      users.map(async (u) => {
        const sub = await SubscriptionService.getUserSubscription(u._id);
        const usage = await SubscriptionService.getUsageSummary(u._id);

        return {
          user: u,
          subscription: sub
            ? {
                status: sub.status,
                startedAt: sub.startedAt,
                expiresAt: sub.expiresAt,
                plan: sub.planId
                  ? {
                      _id: sub.planId._id,
                      name: sub.planId.name,
                      slug: sub.planId.slug,
                    }
                  : null,
              }
            : null,
          usage: usage.usage,
          limits: usage.plan?.limits || {},
        };
      }),
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export default {
  getMySubscription,
  getAvailablePlans,
  switchMyPlan,
  getAdminPlans,
  createAdminPlan,
  updateAdminPlan,
  deleteAdminPlan,
  getAdminSettings,
  updateAdminSettings,
  assignPlanToUser,
  getAdminUsersUsage,
};
