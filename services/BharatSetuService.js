import axios from "axios";
import crypto from "crypto";
import SubscriptionSettings from "../models/SubscriptionSettings.js";
import PaymentTransaction from "../models/PaymentTransaction.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import SubscriptionService from "../services/SubscriptionService.js";

class BharatSetuService {
  async getSettings() {
    const settings = await SubscriptionSettings.findOne({ key: "global" }).lean();
    return {
      userToken: (settings?.bharatsetuUserToken || "6072874f684ef0b45a57856b43b51229").trim(),
      apiUrl: (settings?.bharatsetuApiUrl || "https://bharatsetu.xyz/api").trim().replace(/\/+$/, ""),
      enabled: settings?.bharatsetuEnabled ?? true,
    };
  }

  /**
   * Create BharatSetu payment order
   */
  async createOrder({ userId, planId, billingCycle = "monthly", customerMobile, redirectUrl }) {
    const plan = await SubscriptionPlan.findById(planId);
    if (!plan || !plan.isActive) {
      throw new Error("Plan not found or inactive");
    }

    const amount = billingCycle === "yearly" ? plan.priceYearly : plan.priceMonthly;
    if (!amount || amount <= 0) {
      throw new Error("Invalid plan amount for payment");
    }

    const { userToken, apiUrl } = await this.getSettings();
    const orderId = "TXN" + crypto.randomBytes(16).toString("hex");

    // Clean customer mobile (must be 10 digits)
    let mobile = String(customerMobile || "9999999999").replace(/\D/g, "");
    if (mobile.length > 10) mobile = mobile.slice(-10);
    if (mobile.length < 10) mobile = "9999999999";

    const payload = new URLSearchParams();
    payload.append("customer_mobile", mobile);
    payload.append("user_token", userToken);
    payload.append("amount", String(amount));
    payload.append("order_id", orderId);
    payload.append("redirect_url", redirectUrl || "http://localhost:5173/dashboard/plans");
    payload.append("remark1", `Plan ${plan.name} (${billingCycle})`);
    payload.append("remark2", `User ${String(userId)}`);

    const endpoint = `${apiUrl}/create-order/`;
    console.log(`[BharatSetu] Initiating order ${orderId} for ₹${amount} to ${endpoint}`);

    let response;
    try {
      response = await axios.post(endpoint, payload, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      });
    } catch (err) {
      console.error("[BharatSetu] Order creation HTTP error:", err.response?.data || err.message);
      throw new Error(
        err.response?.data?.message ||
        err.response?.data?.error ||
        "Failed to reach BharatSetu payment gateway"
      );
    }

    const resData = response.data;
    console.log("[BharatSetu] Order Response:", JSON.stringify(resData));

    if (resData.status !== "SUCCESS" && resData.status !== true && resData.message !== "ORDER_CREATED") {
      throw new Error(resData.message || resData.error || "BharatSetu order creation failed");
    }

    const paymentUrl = resData.result?.payment_url || resData.payment_url || "";
    const returnedOrderId = resData.result?.orderId || resData.result?.order_id || orderId;

    // Save transaction in database
    const transaction = new PaymentTransaction({
      userId,
      planId: plan._id,
      orderId,
      gateway: "bharatsetu",
      amount,
      currency: plan.currency || "INR",
      billingCycle,
      customerMobile: mobile,
      paymentUrl,
      status: "pending",
      gatewayResponse: resData,
    });

    await transaction.save();

    return {
      success: true,
      gateway: "bharatsetu",
      orderId,
      returnedOrderId,
      paymentUrl,
      amount,
      currency: plan.currency || "INR",
      plan: {
        _id: plan._id,
        name: plan.name,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
      },
    };
  }

  /**
   * Check order status from BharatSetu & auto-activate plan if successful
   */
  async checkOrderStatus(orderId, userId = null) {
    const query = { orderId };
    if (userId) query.userId = userId;

    const transaction = await PaymentTransaction.findOne(query);
    if (!transaction) {
      throw new Error("Transaction order not found");
    }

    // If already marked as success, return subscription details
    if (transaction.status === "success") {
      const plan = await SubscriptionPlan.findById(transaction.planId);
      return {
        success: true,
        status: "success",
        message: "Payment already verified",
        plan,
      };
    }

    const { userToken, apiUrl } = await this.getSettings();

    // Query status from BharatSetu API
    let isPaid = false;
    let rawStatus = "";
    let checkResponseData = null;

    try {
      const checkPayload = new URLSearchParams();
      checkPayload.append("user_token", userToken);
      checkPayload.append("order_id", orderId);

      const checkRes = await axios.post(`${apiUrl}/check-order-status/`, checkPayload, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      });

      checkResponseData = checkRes.data;
      console.log(`[BharatSetu] Status check response for ${orderId}:`, JSON.stringify(checkResponseData));

      rawStatus = (
        checkResponseData?.status ||
        checkResponseData?.result?.status ||
        checkResponseData?.data?.status ||
        ""
      ).toUpperCase();

      if (
        rawStatus === "SUCCESS" ||
        rawStatus === "COMPLETED" ||
        rawStatus === "PAID" ||
        checkResponseData?.result?.payment_status === "SUCCESS"
      ) {
        isPaid = true;
      }
    } catch (err) {
      console.error(`[BharatSetu] Status check failed for ${orderId}:`, err.message);
    }

    if (isPaid) {
      transaction.status = "success";
      transaction.paidAt = new Date();
      if (checkResponseData) {
        transaction.gatewayResponse = {
          ...transaction.gatewayResponse,
          statusCheck: checkResponseData,
        };
      }
      await transaction.save();

      // Activate plan for user
      const plan = await SubscriptionPlan.findById(transaction.planId);
      const durationDays = transaction.billingCycle === "yearly" ? 365 : (plan?.durationDays || 30);
      const sub = await SubscriptionService.assignPlanToUser(transaction.userId, transaction.planId, {
        durationDays,
      });

      console.log(`✅ [BharatSetu] Order ${orderId} verified & user ${transaction.userId} upgraded to ${plan?.name}`);

      return {
        success: true,
        status: "success",
        message: `Successfully upgraded to ${plan?.name}!`,
        subscription: sub,
        plan: SubscriptionService.toClientPlan(sub.planId),
      };
    }

    return {
      success: true,
      status: transaction.status || "pending",
      rawStatus: rawStatus || "PENDING",
      message: "Payment is pending or awaiting confirmation",
    };
  }

  /**
   * Manual admin / user callback verification fallback
   */
  async verifyPayment(orderId, userId) {
    return await this.checkOrderStatus(orderId, userId);
  }
}

const bharatSetuServiceInstance = new BharatSetuService();
export default bharatSetuServiceInstance;
