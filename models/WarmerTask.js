import mongoose from 'mongoose';

const warmerTaskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      default: 'Auto-Chat Warmup Task',
    },
    participatingSessions: [
      {
        sessionId: { type: String, required: true },
        name: { type: String, default: '' },
        phoneNumber: { type: String, default: '' },
      },
    ],
    conversationTopic: {
      type: String,
      enum: ['casual', 'business', 'ecommerce', 'support', 'tech', 'custom'],
      default: 'casual',
    },
    customDialogues: [
      {
        text: { type: String, required: true },
      },
    ],
    minDelaySeconds: {
      type: Number,
      default: 15,
      min: 5,
      max: 120,
    },
    maxDelaySeconds: {
      type: Number,
      default: 45,
      min: 5,
      max: 300,
    },
    messagesPerSession: {
      type: Number,
      default: 20,
      min: 1,
      max: 500,
    },
    totalMessagesTarget: {
      type: Number,
      default: 40,
    },
    status: {
      type: String,
      enum: ['draft', 'running', 'paused', 'completed', 'stopped', 'failed'],
      default: 'draft',
      index: true,
    },
    stats: {
      totalSent: { type: Number, default: 0 },
      totalFailed: { type: Number, default: 0 },
      progressPercent: { type: Number, default: 0 },
    },
    logs: [
      {
        pairLabel: { type: String, default: 'Pair 1' },
        pairIndex: { type: Number, default: 0 },
        fromSessionId: { type: String, required: true },
        fromName: { type: String, default: '' },
        fromPhone: { type: String, default: '' },
        toSessionId: { type: String, required: true },
        toName: { type: String, default: '' },
        toPhone: { type: String, default: '' },
        message: { type: String, required: true },
        status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
        sentAt: { type: Date, default: Date.now },
        error: { type: String, default: '' },
      },
    ],
    lastError: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model('WarmerTask', warmerTaskSchema);
