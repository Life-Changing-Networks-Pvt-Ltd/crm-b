import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['Todo', 'In Progress', 'In Review', 'Done', 'Blocked'],
    default: 'Todo',
  },
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Urgent'],
    default: 'Medium',
  },
  dueDate: {
    type: Date,
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  department: {
    type: String,
    enum: ['Development', 'SEO', 'Sales', 'Design', 'Marketing', 'General'],
    default: 'General',
  },
  taskType: {
    type: String,
    enum: ['Task', 'Bug', 'Feature', 'SEO', 'Improvement'],
    default: 'Task',
  },
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  activity: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  blockedReason: {
    type: String,
    trim: true,
    default: '',
  },
  submittedAt: { type: Date, default: null },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewDecision: {
    type: String,
    enum: ['', 'approved', 'changes_requested'],
    default: '',
  },
  reviewComment: { type: String, trim: true, default: '' },
  completedAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

taskSchema.index({ createdBy: 1, dueDate: 1 });
taskSchema.index({ createdBy: 1, status: 1, createdAt: -1 });
taskSchema.index({ createdBy: 1, createdAt: -1 });
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ assignedTo: 1, createdAt: -1 });
taskSchema.index({ department: 1, status: 1 });
taskSchema.index({ archivedAt: 1, status: 1, createdAt: -1 });
taskSchema.index({ createdBy: 1, status: 1, dueDate: 1 }, { name: 'task_owner_status_dueDate' });

const Task = mongoose.model('Task', taskSchema);

export default Task;
