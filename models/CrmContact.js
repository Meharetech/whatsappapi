import mongoose from "mongoose";

const crmNoteSchema = new mongoose.Schema(
  {
    note: { type: String, required: true },
    createdBy: { type: String, default: "User" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const crmContactSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: { type: String, default: null, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    chatJid: { type: String, required: true, index: true },
    email: { type: String, default: "", trim: true },
    company: { type: String, default: "", trim: true },
    address: { type: String, default: "" },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    country: { type: String, default: "India", trim: true },
    
    // Customer Classification
    customerType: {
      type: String,
      enum: ["Lead", "Prospect", "Customer", "VIP", "Partner", "Vendor", "Other"],
      default: "Lead",
      index: true,
    },
    leadStatus: {
      type: String,
      enum: [
        "New",
        "Contacted",
        "Qualified",
        "Proposal Sent",
        "In Negotiation",
        "Won",
        "Lost",
        "Churned",
      ],
      default: "New",
      index: true,
    },
    leadSource: {
      type: String,
      enum: [
        "WhatsApp Inbound",
        "Broadcast Campaign",
        "Drip Sequence",
        "Website",
        "Facebook Ad",
        "Instagram",
        "Google",
        "Referral",
        "Cold Outreach",
        "Manual Entry",
        "Other",
      ],
      default: "WhatsApp Inbound",
      index: true,
    },

    // Sales Deal Info
    assignedAgent: { type: String, default: "", trim: true },
    budget: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    product: { type: String, default: "" },
    requirement: { type: String, default: "" },
    expectedClosingDate: { type: Date, default: null },
    
    // Engagement Metrics
    totalPurchases: { type: Number, default: 0 },
    totalConversations: { type: Number, default: 0 },
    lastInteraction: { type: Date, default: Date.now },
    lastInteractionText: { type: String, default: "" },

    // Dynamic Segmentation & Notes
    tags: [{ type: String, trim: true }],
    notes: [crmNoteSchema],
    customFields: { type: Map, of: String, default: {} },
  },
  { timestamps: true }
);

crmContactSchema.index({ userId: 1, phone: 1 }, { unique: true });
crmContactSchema.index({ userId: 1, leadStatus: 1 });
crmContactSchema.index({ userId: 1, customerType: 1 });
crmContactSchema.index({ userId: 1, lastInteraction: -1 });

export default mongoose.model("CrmContact", crmContactSchema);
