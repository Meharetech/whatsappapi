import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import authMiddleware from "../middleware/auth.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import SubscriptionSettings from "../models/SubscriptionSettings.js";
import SubscriptionService from "../services/SubscriptionService.js";

const router = express.Router();

// ── Extract a readable message from any error (including Razorpay SDK errors) ──
function extractErrorMessage(err) {
  if (!err) return "Unknown error";
  // Razorpay SDK throws: { statusCode, error: { description, code, ... } }
  if (err.error?.description) return err.error.description;
  if (err.error?.code) return err.error.code;
  // Standard Error
  if (err.message) return err.message;
  // Plain string
  if (typeof err === "string") return err;
  // Fallback: stringify
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

async function getRazorpayConfig() {
  const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
  const keyId = (settings?.razorpayKeyId || "").trim();
  const keySecret = (settings?.razorpayKeySecret || "").trim();
  if (!keyId || !keySecret) {
    throw new Error("Razorpay keys not configured. Go to Admin → Pricing Plans → Settings and add your Razorpay Key ID and Secret.");
  }
  return { keyId, keySecret };
}

// POST /api/payments/create-order
router.post("/create-order", authMiddleware, async (req, res) => {
  try {
    const { planId, billingCycle = "monthly" } = req.body;
    if (!planId) return res.status(400).json({ success: false, error: "planId is required" });

    const plan = await SubscriptionPlan.findById(planId);
    if (!plan || !plan.isActive) {
      return res.status(404).json({ success: false, error: "Plan not found or inactive" });
    }

    const amount = billingCycle === "yearly" ? plan.priceYearly : plan.priceMonthly;

    // Free / zero price plan — activate directly without payment
    if (!amount || amount <= 0) {
      // Block downgrade: if user currently has a paid active plan, don't allow demo/free
      const currentSub = await SubscriptionService.getUserSubscription(req.user._id);
      if (currentSub?.planId) {
        const currentPlan = currentSub.planId;
        const currentPrice = currentPlan.priceMonthly || currentPlan.priceYearly || 0;
        if (currentPrice > 0 && currentSub.status === "active") {
          return res.status(400).json({
            success: false,
            error: "You cannot downgrade to a free/demo plan while your paid plan is active.",
          });
        }
      }

      await SubscriptionService.assignPlanToUser(req.user._id, planId, {
        durationDays: billingCycle === "yearly" ? 365 : plan.durationDays,
      });
      return res.json({
        success: true,
        free: true,
        message: `${plan.name} plan activated successfully!`,
      });
    }

    // Check if Razorpay is configured; fall back to demo mode if not
    const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
    const hasKeys =
      (settings?.razorpayKeyId || "").trim().length > 0 &&
      (settings?.razorpayKeySecret || "").trim().length > 0;

    if (!hasKeys) {
      if (!settings?.demoEnabled) {
        return res.status(400).json({
          success: false,
          error: "Payment gateway not configured. Please contact the administrator.",
        });
      }
      // Demo mode — simulate a payment order
      return res.json({
        success: true,
        demo: true,
        demoOrderId: `demo_${String(req.user._id).slice(-8)}_${Date.now()}`,
        plan: {
          _id: plan._id,
          name: plan.name,
          priceMonthly: plan.priceMonthly,
          priceYearly: plan.priceYearly,
        },
        amount: Math.round(amount * 100),
        currency: plan.currency || "INR",
        billingCycle,
      });
    }

    // Paid plan — create Razorpay order
    const { keyId, keySecret } = await getRazorpayConfig();

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    let order;
    try {
      order = await razorpay.orders.create({
        amount: Math.round(amount * 100), // paise, must be integer
        currency: plan.currency || "INR",
        receipt: `sub_${String(req.user._id).slice(-8)}_${Date.now()}`,
        notes: {
          userId: String(req.user._id),
          planId: String(plan._id),
          planName: plan.name,
          billingCycle,
        },
      });
    } catch (rzpErr) {
      const msg = extractErrorMessage(rzpErr);
      console.error("Razorpay order creation failed:", rzpErr);
      return res.status(502).json({ success: false, error: `Payment gateway error: ${msg}` });
    }

    console.log(`✅ Razorpay order created: ${order.id} for user ${req.user._id} plan ${plan.name}`);

    return res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      plan: {
        _id: plan._id,
        name: plan.name,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
      },
      key: keyId,
    });
  } catch (err) {
    const msg = extractErrorMessage(err);
    console.error("create-order route error:", err);
    return res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/payments/verify
router.post("/verify", authMiddleware, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId,
      billingCycle = "monthly",
    } = req.body;

    if (!razorpay_order_id || !planId) {
      return res.status(400).json({ success: false, error: "Missing payment verification fields" });
    }

    // Demo payment — skip signature verification
    if (String(razorpay_order_id).startsWith("demo_")) {
      const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
      if (!settings?.demoEnabled) {
        return res.status(400).json({ success: false, error: "Demo mode is not enabled" });
      }
      const demoPlan = await SubscriptionPlan.findById(planId);
      if (!demoPlan) return res.status(404).json({ success: false, error: "Plan not found" });
      const demoDuration = billingCycle === "yearly" ? 365 : demoPlan.durationDays;
      const demoSub = await SubscriptionService.assignPlanToUser(req.user._id, planId, {
        durationDays: demoDuration,
      });
      console.log(`✅ Demo payment — user ${req.user._id} upgraded to ${demoPlan.name}`);
      return res.json({
        success: true,
        message: `Successfully upgraded to ${demoPlan.name} (Demo)`,
        data: {
          subscription: {
            status: demoSub.status,
            startedAt: demoSub.startedAt,
            expiresAt: demoSub.expiresAt,
          },
          plan: SubscriptionService.toClientPlan(demoSub.planId),
        },
      });
    }

    if (!razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: "Missing payment verification fields" });
    }

    const { keySecret } = await getRazorpayConfig();

    const digest = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (digest !== razorpay_signature) {
      console.error("Razorpay signature mismatch");
      return res.status(400).json({ success: false, error: "Payment signature verification failed" });
    }

    const plan = await SubscriptionPlan.findById(planId);
    if (!plan) return res.status(404).json({ success: false, error: "Plan not found" });

    const durationDays = billingCycle === "yearly" ? 365 : plan.durationDays;
    const sub = await SubscriptionService.assignPlanToUser(req.user._id, planId, { durationDays });

    console.log(`✅ Payment verified — user ${req.user._id} upgraded to ${plan.name}`);

    return res.json({
      success: true,
      message: `Successfully upgraded to ${plan.name}`,
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
    const msg = extractErrorMessage(err);
    console.error("verify route error:", err);
    return res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/payments/test-connection — admin only, verifies Razorpay credentials
router.post("/test-connection", authMiddleware, async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.user?.role)) {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }
    const { keyId, keySecret } = await getRazorpayConfig();
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    // Create a ₹1 dummy order to verify credentials
    await razorpay.orders.create({
      amount: 100,
      currency: "INR",
      receipt: `test_${Date.now()}`,
    });
    res.json({ success: true, message: "Razorpay credentials are valid ✅", keyId });
  } catch (err) {
    const msg = extractErrorMessage(err);
    console.error("Razorpay test-connection failed:", err);
    res.status(400).json({
      success: false,
      error: `Invalid credentials: ${msg}. Please check your Key ID and Secret in your Razorpay Dashboard → Settings → API Keys.`,
    });
  }
});

// GET /api/payments/config — returns public key only (no secret)
router.get("/config", authMiddleware, async (req, res) => {
  try {
    const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
    const keyId = (settings?.razorpayKeyId || "").trim();
    res.json({
      success: true,
      data: {
        configured: !!keyId,
        razorpayEnabled: !!settings?.razorpayEnabled,
        keyId,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: extractErrorMessage(err) });
  }
});

export default router;
