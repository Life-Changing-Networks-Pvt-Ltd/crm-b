import mongoose from 'mongoose';
import leadNotificationPreferencesSchema from './schemas/leadNotificationPreferences.js';

const customerSchema = new mongoose.Schema({
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
  website: {
    type: String,
  },
  messageNotes: {
    type: String,
  },
  scheduledDateTime: {
    type: Date,
  },
  address: {
    type: String,
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active',
  },
  totalSpend: {
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
  leadStatus: {
    type: String,
    enum: ['New', 'Demo Scheduled', 'Demo follow-up', 'Interested', 'Not Interested', 'Committed', 'Converted', 'Follow Up'],
    default: 'New'
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
  leadSource: {
    type: String,
    default: 'Direct'
  },
  comments: [{
    text: {
      type: String,
      required: true,
    },
    status: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    attachment: {
      url: String,
      fileType: String
    }
  }]
}, {
  timestamps: true,
});

customerSchema.index({ createdBy: 1, assignedTo: 1, leadStatus: 1, createdAt: -1 });
customerSchema.index({ assignedTo: 1, createdAt: -1, leadStatus: 1 });
customerSchema.index({ createdAt: -1, leadStatus: 1 });
customerSchema.index({ scheduledDateTime: 1 });
customerSchema.index({ createdBy: 1, createdAt: -1 }, { name: 'customer_createdBy_createdAt' });
customerSchema.index({ assignedTo: 1, createdAt: -1 }, { name: 'customer_assignedTo_createdAt' });
customerSchema.index(
  { assignedTo: 1, leadStatus: 1, createdAt: -1 },
  { name: 'customer_assignee_status_createdAt' },
);
customerSchema.index({ name: 1, createdAt: -1 }, { name: 'customer_name_createdAt' });
customerSchema.index({ leadStatus: 1, createdAt: 1 }, { name: 'customer_leadStatus_createdAt' });

const Customer = mongoose.model('Customer', customerSchema);

export default Customer;
