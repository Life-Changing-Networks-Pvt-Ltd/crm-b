import User from '../models/User.js';
import { successResponse, errorResponse } from '../utils/response.js';
import {
  verifyIndiaMartCredentials,
  syncVendorIndiaMartLeads,
} from '../services/indiamartService.js';

// Helper to mask API key for security
const maskKey = (key = '') => {
  if (!key || key.length < 6) return key ? '••••••' : '';
  return key.slice(0, 3) + '••••••••' + key.slice(-3);
};

// @desc    Get IndiaMART integration configuration for the current vendor
// @route   GET /api/integrations/indiamart
// @access  Private
export const getIndiaMartConfig = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('indiamart companyName role');
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    const config = user.indiamart || {};

    return successResponse(res, 200, 'IndiaMART configuration fetched', {
      mobileNumber: config.mobileNumber || '',
      maskedApiKey: maskKey(config.apiKey),
      hasApiKey: Boolean(config.apiKey),
      syncStatus: config.syncStatus || 'disconnected',
      autoSync: config.autoSync !== false,
      lastSyncAt: config.lastSyncAt || null,
      lastError: config.lastError || '',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Save and connect IndiaMART configuration
// @route   POST /api/integrations/indiamart
// @access  Private
export const saveIndiaMartConfig = async (req, res, next) => {
  try {
    const { mobileNumber, apiKey, autoSync = true } = req.body;

    if (!mobileNumber || !apiKey) {
      return errorResponse(res, 400, 'Mobile number and IndiaMART CRM Key are required');
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    // Verify credentials with IndiaMART
    const verification = await verifyIndiaMartCredentials(mobileNumber, apiKey);
    if (!verification.success) {
      return errorResponse(res, 400, verification.message);
    }

    user.indiamart = {
      apiKey: apiKey.trim(),
      mobileNumber: mobileNumber.trim(),
      autoSync: Boolean(autoSync),
      syncStatus: 'connected',
      lastError: '',
      lastSyncAt: new Date(),
    };

    await user.save();

    // Trigger initial lead sync in background
    syncVendorIndiaMartLeads(user._id).catch((err) => {
      console.error(`[IndiaMART] Initial sync after connect failed for ${user.email}:`, err.message);
    });

    return successResponse(res, 200, 'IndiaMART connected successfully! Initial lead sync initiated.', {
      syncStatus: 'connected',
      autoSync: user.indiamart.autoSync,
      mobileNumber: user.indiamart.mobileNumber,
      maskedApiKey: maskKey(user.indiamart.apiKey),
      lastSyncAt: user.indiamart.lastSyncAt,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Trigger manual sync now
// @route   POST /api/integrations/indiamart/sync
// @access  Private
export const triggerIndiaMartSync = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user || !user.indiamart?.apiKey || !user.indiamart?.mobileNumber) {
      return errorResponse(res, 400, 'IndiaMART is not configured. Please save your credentials first.');
    }

    const result = await syncVendorIndiaMartLeads(user._id);

    return successResponse(res, 200, `Sync completed. ${result.created} new leads fetched (${result.skipped} existing skipped).`, result);
  } catch (error) {
    next(error);
  }
};

// @desc    Disconnect IndiaMART
// @route   DELETE /api/integrations/indiamart
// @access  Private
export const disconnectIndiaMart = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    user.indiamart = {
      apiKey: '',
      mobileNumber: '',
      autoSync: false,
      syncStatus: 'disconnected',
      lastSyncAt: null,
      lastError: '',
    };

    await user.save();

    return successResponse(res, 200, 'IndiaMART disconnected successfully');
  } catch (error) {
    next(error);
  }
};
