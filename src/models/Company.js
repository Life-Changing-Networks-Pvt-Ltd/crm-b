import mongoose from 'mongoose';
import leadNotificationPreferencesSchema from './schemas/leadNotificationPreferences.js';

const companySchema = new mongoose.Schema({
  companyName: {
    type: String,
    required: true,
  },
  customerName: {
    type: String,
  },
  customerDesignation: {
    type: String,
  },
  email1: {
    type: String,
  },
  email2: {
    type: String,
  },
  mobileNo: {
    type: String,
    required: true,
  },
  phoneNo: {
    type: String,
  },
  products: {
    type: String,
  },
  businessType: {
    type: String,
  },
  address1: {
    type: String,
    required: true,
  },
  address2: {
    type: String,
  },
  city: {
    type: String,
  },
  state: {
    type: String,
  },
  country: {
    type: String,
  },
  website1: {
    type: String,
    required: true,
  },
  website2: {
    type: String,
  },
  followTypeDate: {
    type: Date,
  },
  scheduledDateTime: {
    type: Date,
  },
  followType: {
    type: String,
  },
  followUpRequired: {
    type: Boolean,
    default: false,
  },
  followUpDateTime: {
    type: Date,
    default: null,
  },
  followUpType: {
    type: String,
    enum: ['Call', 'WhatsApp', 'Email', 'Meeting', 'Demo', 'Other'],
    default: null,
  },
  followUpPriority: {
    type: String,
    enum: ['Low', 'Normal', 'High', 'Urgent'],
    default: null,
  },
  followUpReminder: {
    type: String,
    enum: ['15_minutes', '30_minutes', '1_hour', '1_day'],
    default: null,
  },
  messageNotes: {
    type: String,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  leadSource: { type: String, default: 'Direct' },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  leadStatus: {
    type: String,
    enum: ['New', 'Demo Scheduled', 'Demo follow-up', 'Interested', 'Not Interested', 'Committed', 'Converted', 'Follow Up'],
    default: 'New'
  },
  leadStatusChangedAt: {
    type: Date,
  },
  notificationPreferences: {
    type: leadNotificationPreferencesSchema,
    default: () => ({}),
  },
  statusDetails: {
    status: String,
    note: { type: String, maxlength: 4000 },
    productService: { type: String, maxlength: 500 },
    expectedDecisionDate: Date,
    demoDateTime: Date,
    demoFollowUpDateTime: Date,
    demoMode: { type: String, enum: ['Online', 'On-site', null], default: null },
    meetingLink: { type: String, maxlength: 1000 },
    location: { type: String, maxlength: 500 },
    reminder: String,
    reason: { type: String, maxlength: 500 },
    requirement: { type: String, maxlength: 2000 },
    estimatedDealValue: Number,
    expectedClosingDate: Date,
    committedProductService: { type: String, maxlength: 500 },
    dealValue: Number,
    expectedCompletionDate: Date,
    convertedAt: Date,
    finalDealValue: Number,
    savedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    savedAt: Date,
  },
  comments: [{
    text: { type: String, required: true },
    status: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    attachment: {
      url: String,
      fileType: String
    }
  }]
}, {
  timestamps: true,
});

companySchema.index({ createdBy: 1, assignedTo: 1, leadStatus: 1, createdAt: -1 });
companySchema.index({ assignedTo: 1, createdAt: -1, leadStatus: 1 });
companySchema.index({ createdAt: -1, leadStatus: 1 });
companySchema.index({ scheduledDateTime: 1, followTypeDate: 1 });
companySchema.index({ followUpRequired: 1, followUpDateTime: 1 });
companySchema.index({ createdBy: 1, createdAt: -1 }, { name: 'company_createdBy_createdAt' });
companySchema.index({ assignedTo: 1, createdAt: -1 }, { name: 'company_assignedTo_createdAt' });
companySchema.index(
  { assignedTo: 1, leadStatus: 1, createdAt: -1 },
  { name: 'company_assignee_status_createdAt' },
);
companySchema.index({ city: 1, createdAt: -1 }, { name: 'company_city_createdAt' });
companySchema.index({ leadStatus: 1, createdAt: 1 }, { name: 'company_leadStatus_createdAt' });

const Company = mongoose.model('Company', companySchema);

export default Company;
