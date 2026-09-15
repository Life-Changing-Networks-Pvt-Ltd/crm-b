import mongoose from 'mongoose';
import leadNotificationPreferencesSchema from './schemas/leadNotificationPreferences.js';

const leadSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
  },
  phone: {
    type: String,
  },
  company: {
    type: String,
  },
  designation: {
    type: String,
  },
  address: {
    type: String,
  },
  website: {
    type: String,
  },
  messageNotes: {
    type: String,
  },
  scheduledDateTime: {
    type: Date,
  },
  status: {
    type: String,
    enum: ['New', 'Demo Scheduled', 'Demo follow-up', 'Interested', 'Not Interested', 'Committed', 'Converted', 'Follow Up'],
    default: 'New',
  },
  statusDetails: {
    status: String,
    demoFollowUpDateTime: Date,
    reminder: String,
    note: { type: String, maxlength: 4000 },
    savedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    savedAt: Date,
  },
  leadStatusChangedAt: {
    type: Date,
  },
  notificationPreferences: {
    type: leadNotificationPreferencesSchema,
    default: () => ({}),
  },
  meetingsCount: {
    type: Number,
    default: 0,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  assignedTo: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  comments: [{
    text: {
      type: String,
      required: true,
      maxlength: 4000,
    },
    status: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    attachment: {
      url: String,
      fileType: String,
    },
  }],
}, {
  timestamps: true,
});

leadSchema.index({ createdBy: 1, assignedTo: 1, status: 1, createdAt: -1 });
leadSchema.index({ scheduledDateTime: 1 });

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
