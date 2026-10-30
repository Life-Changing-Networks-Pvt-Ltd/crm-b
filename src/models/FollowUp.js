import mongoose from 'mongoose';

const followUpSchema = new mongoose.Schema({
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
  },
  activeKey: {
    type: String,
  },
  companyName: {
    type: String,
    required: true,
    trim: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 4000,
  },
  sourceStatus: {
    type: String,
    enum: ['Follow Up', 'Demo follow-up', 'Demo Scheduled'],
    default: 'Follow Up',
  },
  attachment: {
    url: String,
    fileType: String,
  },
  followUpDateTime: {
    type: Date,
    required: true,
  },
  type: {
    type: String,
    enum: ['Call', 'WhatsApp', 'Email', 'Meeting', 'Demo', 'Other'],
    required: true,
  },
  priority: {
    type: String,
    enum: ['Low', 'Normal', 'High', 'Urgent'],
    required: true,
  },
  reminderBefore: {
    type: String,
    enum: ['15_minutes', '30_minutes', '1_hour', '1_day'],
    required: true,
  },
  status: {
    type: String,
    enum: ['Pending', 'Snoozed', 'Completed', 'Cancelled'],
    default: 'Pending',
  },
  assignedTo: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  nextReminderAt: {
    type: Date,
    required: true,
  },
  lastRemindedAt: Date,
  reminderCount: {
    type: Number,
    default: 0,
  },
  snoozedUntil: Date,
  completedAt: Date,
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  version: {
    type: Number,
    default: 1,
  },
}, {
  timestamps: true,
});

followUpSchema.index({ activeKey: 1 }, { unique: true, sparse: true });
followUpSchema.index({ status: 1, nextReminderAt: 1 });
followUpSchema.index({ assignedTo: 1, status: 1, nextReminderAt: 1 });
followUpSchema.index({ lead: 1, createdAt: -1 });

const FollowUp = mongoose.model('FollowUp', followUpSchema);

export default FollowUp;
