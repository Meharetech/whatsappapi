import mongoose from "mongoose";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import SubscriptionSettings from "../models/SubscriptionSettings.js";
import UserSubscription from "../models/UserSubscription.js";
import User from "../models/User.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import Campaign from "../models/Campaign.js";
import NumberList from "../models/NumberList.js";
import MediaCollection from "../models/Media.js";

const DEFAULT_FEATURES = [
  { key: "sessions", label: "WhatsApp Sessions", enabled: true },
  { key: "campaigns", label: "Campaigns", enabled: true },
  { key: "numberLists", label: "Number Lists", enabled: true },
  { key: "media", label: "Media Storage", enabled: true },
  { key: "apiMessaging", label: "API Message Sending", enabled: true },
  { key: "planSwitch", label: "User Plan Switching", enabled: true },
];

const DEFAULT_PLANS = [
  {
    name: "Demo",
    slug: "demo",
    description: "Starter trial plan for new users",
    priceMonthly: 0,
    priceYearly: 0,
    durationDays: 7,
    isDemo: true,
    sortOrder: 1,
    limits: {
      sessions: -1,
      campaigns: 2,
      numberLists: -1,
      storageMb: 200,
      messagesDaily: 50,
      messagesWeekly: 200,
      messagesMonthly: 500,
    },
    features: DEFAULT_FEATURES,
  },
  {
    name: "Basic",
    slug: "basic",
    description: "Good for individuals",
    priceMonthly: 499,
    priceYearly: 4990,
    durationDays: 30,
    sortOrder: 10,
    limits: {
      sessions: -1,
      campaigns: 10,
      numberLists: -1,
      storageMb: 300,
      messagesDaily: 300,
      messagesWeekly: 1500,
      messagesMonthly: 5000,
    },
    features: DEFAULT_FEATURES,
  },
  {
    name: "Advanced",
    slug: "advanced",
    description: "Great for growing teams",
    priceMonthly: 1499,
    priceYearly: 14990,
    durationDays: 30,
    sortOrder: 20,
    limits: {
      sessions: -1,
      campaigns: 40,
      numberLists: -1,
      storageMb: 1024,
      messagesDaily: 2000,
      messagesWeekly: 10000,
      messagesMonthly: 40000,
    },
    features: DEFAULT_FEATURES,
  },
  {
    name: "Pro",
    slug: "pro",
    description: "High-volume and enterprise ready",
    priceMonthly: 3999,
    priceYearly: 39990,
    durationDays: 30,
    sortOrder: 30,
    limits: {
      sessions: -1,
      campaigns: -1,
      numberLists: -1,
      storageMb: 5120,
      messagesDaily: -1,
      messagesWeekly: -1,
      messagesMonthly: -1,
    },
    features: DEFAULT_FEATURES,
  },
];

class LimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LimitError";
    this.statusCode = 403;
    this.code = "LIMIT_EXCEEDED";
    this.details = details;
  }
}

function getISOWeekKey(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getMessageWindowKeys(now = new Date()) {
  return {
    dayKey: now.toISOString().slice(0, 10),
    weekKey: getISOWeekKey(now),
    monthKey: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

function isUnlimited(v) {
  return v === undefined || v === null || Number(v) < 0;
}

function normalizeFeatureKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase();
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

class SubscriptionService {
  async bootstrapDefaults() {
    for (const plan of DEFAULT_PLANS) {
      await SubscriptionPlan.updateOne(
        { slug: plan.slug },
        { $setOnInsert: plan },
        { upsert: true },
      );
    }

    await SubscriptionPlan.updateMany({}, { $set: { "limits.sessions": -1, "limits.numberLists": -1 } });

    const demoPlan = await SubscriptionPlan.findOne({ slug: "demo" });
    const settings = await SubscriptionSettings.findOneAndUpdate(
      { key: "global" },
      {
        $setOnInsert: {
          demoEnabled: true,
          demoDurationDays: 3,
          defaultTrialDays: 3,
          demoPlanId: demoPlan?._id || null,
          allowUserPlanSwitch: true,
        },
      },
      { upsert: true, new: true },
    );

    if (!settings.demoPlanId && demoPlan?._id) {
      settings.demoPlanId = demoPlan._id;
      await settings.save();
    }
  }

  async getSettings() {
    return SubscriptionSettings.findOne({ key: "global" }).populate(
      "demoPlanId",
    );
  }

  async ensureUserSubscription(userDocOrId) {
    const user =
      typeof userDocOrId === "object"
        ? userDocOrId
        : await User.findById(userDocOrId).lean();

    if (!user) {
      throw new Error("User not found for subscription setup");
    }

    let sub = await UserSubscription.findOne({ userId: user._id }).populate(
      "planId",
    );
    if (sub) {
      return sub;
    }

    const settings = await this.getSettings();

    let selectedPlan = null;
    let status = "active";
    let expiresAt = null;

    if (settings?.demoEnabled && settings?.demoPlanId) {
      selectedPlan = await SubscriptionPlan.findById(settings.demoPlanId);
      status = "trial";
      const trialDays = Math.max(Number(settings.defaultTrialDays || settings.demoDurationDays) || 3, 1);
      expiresAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    }

    if (!selectedPlan) {
      selectedPlan = await SubscriptionPlan.findOne({
        isActive: true,
        isDemo: false,
      }).sort({ sortOrder: 1 });
    }

    if (!selectedPlan) {
      throw new Error("No active subscription plan available");
    }

    if (!expiresAt && (selectedPlan.isDemo || status === "trial")) {
      const trialDays = Math.max(Number(settings?.defaultTrialDays || settings?.demoDurationDays) || 3, 1);
      expiresAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    }

    sub = await UserSubscription.create({
      userId: user._id,
      planId: selectedPlan._id,
      status,
      startedAt: new Date(),
      expiresAt,
      trialUsed: status === "trial" || selectedPlan.isDemo,
      location: user.location || "",
      usage: {
        sessions: 0,
        campaigns: 0,
        numberLists: 0,
        storageBytes: 0,
        messages: {
          dayKey: "",
          dayCount: 0,
          weekKey: "",
          weekCount: 0,
          monthKey: "",
          monthCount: 0,
        },
      },
    });

    return UserSubscription.findById(sub._id).populate("planId");
  }

  async adjustUserSubscriptionDays(userId, { daysDelta, customExpiresAt, planId, status } = {}) {
    let sub = await this.getUserSubscription(userId);
    if (!sub) throw new Error("User subscription not found");

    if (planId && String(planId) !== String(sub.planId?._id)) {
      sub = await this.assignPlanToUser(userId, planId);
    }

    if (customExpiresAt) {
      sub.expiresAt = new Date(customExpiresAt);
    } else if (daysDelta !== undefined && daysDelta !== null) {
      const currentExpiry = sub.expiresAt && new Date(sub.expiresAt) > new Date()
        ? new Date(sub.expiresAt)
        : new Date();
      sub.expiresAt = new Date(currentExpiry.getTime() + Number(daysDelta) * 24 * 60 * 60 * 1000);
    }

    if (status) {
      sub.status = status;
    } else if (sub.expiresAt && sub.expiresAt > new Date() && sub.status === "expired") {
      sub.status = "active";
    }

    await sub.save();
    return UserSubscription.findById(sub._id).populate("planId");
  }

  async getUserSubscription(userDocOrId) {
    const userId =
      typeof userDocOrId === "object" ? userDocOrId._id : userDocOrId;
    await this.ensureUserSubscription(userDocOrId);
    const sub = await UserSubscription.findOne({ userId }).populate("planId");

    if (
      sub &&
      sub.expiresAt &&
      sub.expiresAt < new Date() &&
      sub.status !== "expired"
    ) {
      sub.status = "expired";
      await sub.save();
    }

    return sub;
  }

  async recalculateUsage(userId) {
    const id = new mongoose.Types.ObjectId(userId);

    const [sessions, campaigns, numberLists, storageAgg] = await Promise.all([
      WhatsAppSession.countDocuments({ userId: id }),
      Campaign.countDocuments({ userId: id }),
      NumberList.countDocuments({ userId: id }),
      MediaCollection.aggregate([
        { $match: { userId: id } },
        { $group: { _id: null, total: { $sum: "$totalSize" } } },
      ]),
    ]);

    const storageBytes = storageAgg?.[0]?.total || 0;

    const sub = await this.getUserSubscription(userId);
    if (!sub) throw new Error("Subscription not found");

    sub.usage.sessions = sessions;
    sub.usage.campaigns = campaigns;
    sub.usage.numberLists = numberLists;
    sub.usage.storageBytes = storageBytes;
    sub.usage.updatedAt = new Date();
    await sub.save();

    return sub;
  }

  async getUsageSummary(userId) {
    const sub = await this.recalculateUsage(userId);
    const plan = sub.planId;
    const keys = getMessageWindowKeys();

    const usageMessages = sub.usage?.messages || {};
    const dayCount =
      usageMessages.dayKey === keys.dayKey ? usageMessages.dayCount : 0;
    const weekCount =
      usageMessages.weekKey === keys.weekKey ? usageMessages.weekCount : 0;
    const monthCount =
      usageMessages.monthKey === keys.monthKey ? usageMessages.monthCount : 0;

    let expiresAt = sub.expiresAt;
    if (!expiresAt && plan) {
      const durationDays = Number(plan.durationDays) || (plan.isDemo ? 3 : 30);
      const start = sub.startedAt ? new Date(sub.startedAt) : new Date();
      expiresAt = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);
      sub.expiresAt = expiresAt;
      await sub.save().catch(() => {});
    }

    return {
      plan: {
        id: plan._id,
        _id: plan._id,
        name: plan.name,
        slug: plan.slug,
        isDemo: plan.isDemo,
        durationDays: plan.durationDays,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        limits: {
          ...(plan.limits || {}),
          sessions: -1,
          numberLists: -1,
        },
        features: plan.features,
      },
      subscription: {
        status: sub.status,
        startedAt: sub.startedAt,
        expiresAt: expiresAt,
        trialUsed: Boolean(sub.trialUsed || sub.status === "trial" || plan?.isDemo),
      },
      usage: {
        sessions: sub.usage.sessions || 0,
        campaigns: sub.usage.campaigns || 0,
        numberLists: sub.usage.numberLists || 0,
        storageBytes: sub.usage.storageBytes || 0,
        storageHuman: formatBytes(sub.usage.storageBytes || 0),
        messagesDaily: dayCount,
        messagesWeekly: weekCount,
        messagesMonthly: monthCount,
      },
    };
  }

  isFeatureEnabled(plan, featureKey) {
    const key = normalizeFeatureKey(featureKey);
    if (!key) return true;

    const features = Array.isArray(plan?.features) ? plan.features : [];
    if (features.length === 0) return true;

    const feature = features.find((f) => normalizeFeatureKey(f?.key) === key);
    if (!feature) return true;
    return feature.enabled !== false;
  }

  async assertFeatureEnabled(user, featureKey) {
    const sub = await this.getUserSubscription(user?._id || user);
    if (!sub?.planId) {
      throw new Error("Subscription plan not found");
    }

    const isExpired = sub.status === "expired" || 
      sub.status === "cancelled" || 
      (sub.expiresAt && new Date(sub.expiresAt).getTime() < Date.now());

    if (isExpired) {
      if (sub.status !== "expired") {
        sub.status = "expired";
        await sub.save().catch(() => {});
      }
      throw new LimitError("Your subscription plan has expired. Please upgrade to continue.", {
        reason: "subscription_expired",
        subscription: sub,
      });
    }

    if (!this.isFeatureEnabled(sub.planId, featureKey)) {
      throw new LimitError("This feature is disabled in your current plan.", {
        reason: "feature_disabled",
        feature: featureKey,
        plan: this.toClientPlan(sub.planId),
      });
    }
  }

  isPlanEligibleForUser(plan, user) {
    if (!plan || !user) return false;
    if (!plan.isActive) return false;

    const roleAllowed =
      !Array.isArray(plan.assignToRoles) ||
      plan.assignToRoles.length === 0 ||
      plan.assignToRoles.includes(user.role);

    const userLocation = String(user.location || "");
    const locationAllowed =
      !Array.isArray(plan.assignToLocations) ||
      plan.assignToLocations.length === 0 ||
      plan.assignToLocations.includes(userLocation);

    return roleAllowed && locationAllowed;
  }

  getLimitValue(plan, key) {
    if (key === "numberLists" || key === "sessions") return -1;
    return Number(plan?.limits?.[key]);
  }

  async assertResourceLimit(user, resourceKey, increment = 1) {
    const summary = await this.getUsageSummary(user._id);
    const { plan, subscription, usage } = summary;

    const isExpired = subscription.status === "expired" ||
      subscription.status === "cancelled" ||
      (subscription.expiresAt && new Date(subscription.expiresAt).getTime() < Date.now());

    if (isExpired) {
      throw new LimitError("Your subscription plan has expired. Please upgrade your plan.", {
        reason: "subscription_expired",
        subscription,
      });
    }

    if (resourceKey === "sessions" || resourceKey === "numberLists") {
      return summary;
    }

    const map = {
      sessions: {
        limitKey: "sessions",
        used: usage.sessions,
        label: "sessions",
        featureKey: "sessions",
      },
      campaigns: {
        limitKey: "campaigns",
        used: usage.campaigns,
        label: "campaigns",
        featureKey: "campaigns",
      },
      numberLists: {
        limitKey: "numberLists",
        used: usage.numberLists,
        label: "number lists",
        featureKey: "numberLists",
      },
    };

    const target = map[resourceKey];
    if (!target) {
      throw new Error(`Unsupported resource limit key: ${resourceKey}`);
    }

    await this.assertFeatureEnabled(user, target.featureKey);

    const limit = this.getLimitValue(plan, target.limitKey);
    if (!isUnlimited(limit) && target.used + increment > limit) {
      throw new LimitError(
        `Your plan limit for ${target.label} has been reached.`,
        {
          resource: resourceKey,
          used: target.used,
          requested: increment,
          limit,
          plan,
        },
      );
    }

    return summary;
  }

  async assertContactsLimit(user, count = 1) {
    return { unlimited: true };
  }

  async assertStorageLimit(user, incomingBytes = 0) {
    const summary = await this.getUsageSummary(user._id);
    await this.assertFeatureEnabled(user, "media");

    const limitMb = this.getLimitValue(summary.plan, "storageMb");
    if (isUnlimited(limitMb)) {
      return summary;
    }

    const limitBytes = limitMb * 1024 * 1024;
    const used = summary.usage.storageBytes;

    if (used + incomingBytes > limitBytes) {
      throw new LimitError("Storage limit exceeded for your current plan.", {
        resource: "storage",
        usedBytes: used,
        incomingBytes,
        limitBytes,
        usedHuman: formatBytes(used),
        incomingHuman: formatBytes(incomingBytes),
        limitHuman: formatBytes(limitBytes),
        plan: summary.plan,
      });
    }

    return summary;
  }

  async assertMessageQuota(user, count = 1) {
    const sub = await this.getUserSubscription(user._id);
    const plan = sub.planId;

    if (sub.status === "expired" || sub.status === "cancelled") {
      throw new LimitError("Subscription expired. Please upgrade your plan.", {
        reason: "subscription_expired",
        subscription: {
          status: sub.status,
          startedAt: sub.startedAt,
          expiresAt: sub.expiresAt,
        },
      });
    }

    await this.assertFeatureEnabled(user, "apiMessaging");

    const keys = getMessageWindowKeys();

    const messages = sub.usage?.messages || {};
    const dayCount = messages.dayKey === keys.dayKey ? messages.dayCount : 0;
    const weekCount =
      messages.weekKey === keys.weekKey ? messages.weekCount : 0;
    const monthCount =
      messages.monthKey === keys.monthKey ? messages.monthCount : 0;

    const dailyLimit = this.getLimitValue(plan, "messagesDaily");
    const weeklyLimit = this.getLimitValue(plan, "messagesWeekly");
    const monthlyLimit = this.getLimitValue(plan, "messagesMonthly");

    if (!isUnlimited(dailyLimit) && dayCount + count > dailyLimit) {
      throw new LimitError("Daily message limit reached.", {
        resource: "messagesDaily",
        used: dayCount,
        requested: count,
        limit: dailyLimit,
      });
    }
    if (!isUnlimited(weeklyLimit) && weekCount + count > weeklyLimit) {
      throw new LimitError("Weekly message limit reached.", {
        resource: "messagesWeekly",
        used: weekCount,
        requested: count,
        limit: weeklyLimit,
      });
    }
    if (!isUnlimited(monthlyLimit) && monthCount + count > monthlyLimit) {
      throw new LimitError("Monthly message limit reached.", {
        resource: "messagesMonthly",
        used: monthCount,
        requested: count,
        limit: monthlyLimit,
      });
    }

    return {
      dayCount,
      weekCount,
      monthCount,
      limits: {
        messagesDaily: dailyLimit,
        messagesWeekly: weeklyLimit,
        messagesMonthly: monthlyLimit,
      },
      plan,
    };
  }

  async consumeMessageQuota(userId, count = 1) {
    const sub = await this.getUserSubscription(userId);
    const keys = getMessageWindowKeys();

    if (!sub.usage?.messages) {
      sub.usage.messages = {
        dayKey: keys.dayKey,
        dayCount: 0,
        weekKey: keys.weekKey,
        weekCount: 0,
        monthKey: keys.monthKey,
        monthCount: 0,
      };
    }

    if (sub.usage.messages.dayKey !== keys.dayKey) {
      sub.usage.messages.dayKey = keys.dayKey;
      sub.usage.messages.dayCount = 0;
    }
    if (sub.usage.messages.weekKey !== keys.weekKey) {
      sub.usage.messages.weekKey = keys.weekKey;
      sub.usage.messages.weekCount = 0;
    }
    if (sub.usage.messages.monthKey !== keys.monthKey) {
      sub.usage.messages.monthKey = keys.monthKey;
      sub.usage.messages.monthCount = 0;
    }

    sub.usage.messages.dayCount += count;
    sub.usage.messages.weekCount += count;
    sub.usage.messages.monthCount += count;
    sub.usage.updatedAt = new Date();
    await sub.save();

    return sub.usage.messages;
  }

  async getAvailablePlansForUser(user) {
    const plans = await SubscriptionPlan.find({ isActive: true }).sort({
      sortOrder: 1,
    });
    return plans.filter((plan) => this.isPlanEligibleForUser(plan, user));
  }

  async assignPlanToUser(userId, planId, options = {}) {
    const plan = await SubscriptionPlan.findById(planId);
    if (!plan || !plan.isActive) {
      throw new Error("Plan not found or inactive");
    }

    const start = options.startDate ? new Date(options.startDate) : new Date();
    const durationDays =
      Number(options.durationDays) || Number(plan.durationDays) || 30;

    const sub = await this.getUserSubscription(userId);
    sub.planId = plan._id;
    sub.status = plan.isDemo ? "trial" : "active";
    if (plan.isDemo || sub.status === "trial") {
      sub.trialUsed = true;
    }
    sub.startedAt = start;
    sub.expiresAt =
      durationDays > 0
        ? new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000)
        : null;

    await sub.save();
    await sub.populate("planId");

    return sub;
  }

  toClientPlan(plan) {
    return {
      _id: plan._id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      currency: plan.currency,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      durationDays: plan.durationDays,
      isActive: plan.isActive,
      isDemo: plan.isDemo,
      isCustom: plan.isCustom,
      assignToRoles: plan.assignToRoles || [],
      assignToLocations: plan.assignToLocations || [],
      limits: {
        ...(plan.limits || {}),
        sessions: -1,
        numberLists: -1,
      },
      features: plan.features || [],
      sortOrder: plan.sortOrder,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
}

export { LimitError };
export default new SubscriptionService();
