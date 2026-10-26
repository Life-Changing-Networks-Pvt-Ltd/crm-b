import mongoose from 'mongoose';
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    role: {
      type: String,
      required: true,
      default: 'user',
    },
    roleRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      default: null,
    },
    teams: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    }],
    permissionOverrides: {
      allow: {
        type: [String],
        default: [],
      },
      deny: {
        type: [String],
        default: [],
      },
    },
    scopeOverrides: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    companyName: {
      type: String,
      trim: true,
      default: '',
    },
    indiamart: {
      apiKey: { type: String, trim: true, default: '' },
      mobileNumber: { type: String, trim: true, default: '' },
      autoSync: { type: Boolean, default: true },
      lastSyncAt: { type: Date, default: null },
      syncStatus: {
        type: String,
        enum: ['connected', 'disconnected', 'error'],
        default: 'disconnected',
      },
      lastError: { type: String, default: '' },
    },
    plivoEndpointId: { type: String, select: false },
    plivoEndpointUsername: { type: String, select: false },
    plivoEndpointPassword: { type: String, select: false },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt
  }
);

userSchema.index({ parent: 1 });
userSchema.index({ teams: 1, status: 1 });
userSchema.index({ roleRef: 1, status: 1 });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ isActive: 1, name: 1 }, { name: 'user_active_name' });
userSchema.index({ status: 1, createdAt: -1 }, { name: 'user_status_createdAt' });
userSchema.index({ role: 1, createdAt: -1 }, { name: 'user_role_createdAt' });
userSchema.index({ 'indiamart.syncStatus': 1, 'indiamart.autoSync': 1 });

userSchema.pre('validate', function () {
  this.isActive = this.status !== 'inactive';
});



import bcrypt from 'bcrypt';

// Method to compare passwords
userSchema.methods.matchPassword = async function (enteredPassword) {
  // If stored password is a hash
  if (this.password.startsWith('$2b$') || this.password.startsWith('$2a$')) {
    return await bcrypt.compare(enteredPassword, this.password);
  }
  // Fallback to plaintext comparison
  return enteredPassword === this.password;
};

// Encrypt password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }
  
  // Hash the password if it isn't already a bcrypt hash
  if (!this.password.startsWith('$2b$') && !this.password.startsWith('$2a$')) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
});

// Never expose credentials in API responses.
userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.password;
  delete user.plivoEndpointId;
  delete user.plivoEndpointUsername;
  delete user.plivoEndpointPassword;
  return user;
};

const User = mongoose.model('User', userSchema);

export default User;
