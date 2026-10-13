import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import authMiddleware from "../middleware/auth.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import SubscriptionSettings from "../models/SubscriptionSettings.js";
import SubscriptionService from "../services/SubscriptionService.js";
import BharatSetuService from "../services/BharatSetuService.js";
import PaymentTransaction from "../models/PaymentTransaction.js";

const router = express.Router();

// ── Extract a readable message from any error (including SDK errors) ──
function extractErrorMessage(err) {
  if (!err) return "Unknown error";
  if (err.error?.description) return err.error.description;
  if (err.error?.code) return err.error.code;
  if (err.message) return err.message;
  if (typeof err === "string") return err;
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
    const { planId, billingCycle = "monthly", customerMobile, redirectUrl } = req.body;
    if (!planId) return res.status(400).json({ success: false, error: "planId is required" });

    const plan = await SubscriptionPlan.findById(planId);
    if (!plan || !plan.isActive) {
      return res.status(404).json({ success: false, error: "Plan not found or inactive" });
    }

    const amount = billingCycle === "yearly" ? plan.priceYearly : plan.priceMonthly;

    // Free / zero price plan — activate directly without payment
    if (!amount || amount <= 0 || plan.isDemo) {
      const currentSub = await SubscriptionService.getUserSubscription(req.user._id);

      // Check if user already used their one-time trial
      if (currentSub?.trialUsed || currentSub?.status === "expired" || (currentSub?.expiresAt && new Date(currentSub.expiresAt) < new Date())) {
        return res.status(400).json({
          success: false,
          error: "You have already used your free trial. Please upgrade to a paid plan to continue.",
        });
      }

      // Block downgrade: if user currently has a paid active plan, don't allow demo/free
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

    const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
    const activeGateway = settings?.activeGateway || (settings?.bharatsetuEnabled !== false ? "bharatsetu" : "razorpay");

    // ── GATEWAY 1: BharatSetu Payment Gateway (Default / Configured) ──
    if (activeGateway === "bharatsetu" && settings?.bharatsetuEnabled !== false) {
      try {
        const clientRedirectUrl = redirectUrl || `${req.headers.origin || "http://localhost:5173"}/dashboard/plans`;
        const result = await BharatSetuService.createOrder({
          userId: req.user._id,
          planId,
          billingCycle,
          customerMobile: customerMobile || req.user.phone,
          redirectUrl: clientRedirectUrl,
        });
        return res.json(result);
      } catch (bsErr) {
        console.error("[BharatSetu] Order create error:", bsErr.message);
        // If BharatSetu fails and Razorpay is not configured, check demo mode
        const hasRazorpay = (settings?.razorpayKeyId || "").trim().length > 0;
        if (!hasRazorpay && settings?.demoEnabled) {
          console.log("[Payment] Falling back to Demo mode after BharatSetu error");
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
        return res.status(502).json({ success: false, error: `Payment gateway error: ${bsErr.message}` });
      }
    }

    // ── GATEWAY 2: Razorpay ──
    const hasKeys =
      (settings?.razorpayKeyId || "").trim().length > 0 &&
      (settings?.razorpayKeySecret || "").trim().length > 0;

    if (activeGateway === "razorpay" && hasKeys) {
      const { keyId, keySecret } = await getRazorpayConfig();
      const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

      let order;
      try {
        order = await razorpay.orders.create({
          amount: Math.round(amount * 100), // paise
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
        gateway: "razorpay",
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
    }

    // ── GATEWAY 3: Demo Mode ──
    if (settings?.demoEnabled) {
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

    return res.status(400).json({
      success: false,
      error: "Payment gateway not configured. Please contact the administrator.",
    });
  } catch (err) {
    const msg = extractErrorMessage(err);
    console.error("create-order route error:", err);
    return res.status(500).json({ success: false, error: msg });
  }
});

// POST /api/payments/check-status/:orderId — Check BharatSetu payment status
router.post("/check-status/:orderId", authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ success: false, error: "orderId is required" });
    }

    const result = await BharatSetuService.checkOrderStatus(orderId, req.user._id);
    return res.json(result);
  } catch (err) {
    console.error("Payment status check error:", err);
    return res.status(400).json({ success: false, error: err.message || "Failed to check order status" });
  }
});

// POST /api/payments/verify-bharatsetu — Direct verification & activation
router.post("/verify-bharatsetu", authMiddleware, async (req, res) => {
  try {
    const { orderId, planId, billingCycle = "monthly" } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, error: "orderId is required" });
    }

    const result = await BharatSetuService.verifyPayment(orderId, req.user._id);
    return res.json(result);
  } catch (err) {
    console.error("BharatSetu verify error:", err);
    return res.status(400).json({ success: false, error: err.message || "Verification failed" });
  }
});

// POST /api/payments/verify — Legacy / Razorpay & Demo verification
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

// GET /api/payments/config — returns public gateway config
router.get("/config", authMiddleware, async (req, res) => {
  try {
    const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
    const keyId = (settings?.razorpayKeyId || "").trim();
    const activeGateway = settings?.activeGateway || (settings?.bharatsetuEnabled !== false ? "bharatsetu" : "razorpay");

    res.json({
      success: true,
      data: {
        activeGateway,
        bharatsetuEnabled: settings?.bharatsetuEnabled !== false,
        razorpayConfigured: !!keyId,
        razorpayEnabled: !!settings?.razorpayEnabled,
        keyId,
        demoEnabled: !!settings?.demoEnabled,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: extractErrorMessage(err) });
  }
});

// Webhook / Callback handler
router.post("/webhook", async (req, res) => {
  try {
    console.log("[Payment Webhook] Received event:", JSON.stringify(req.body));
    const { order_id, status } = req.body;
    if (order_id) {
      await BharatSetuService.checkOrderStatus(order_id);
    }
    res.json({ status: "SUCCESS" });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
