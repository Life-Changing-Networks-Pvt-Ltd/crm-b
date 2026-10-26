import User from '../models/User.js';
import Lead from '../models/Lead.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { isAdminUser } from '../utils/hierarchy.js';

// @desc    Get all vendors with metrics (Leads & Employees count)
// @route   GET /api/vendors
// @access  Private (Admin only)
export const getVendors = async (req, res, next) => {
  try {
    if (!isAdminUser(req.user)) {
      return errorResponse(res, 403, 'Access denied. Admin access required.');
    }

    const { search, status } = req.query;
    const filter = { role: 'vendor' };

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (search) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$or = [{ name: regex }, { email: regex }, { companyName: regex }, { phone: regex }];
    }

    const vendors = await User.find(filter)
      .select('-password -plivoEndpointId -plivoEndpointUsername -plivoEndpointPassword')
      .sort({ createdAt: -1 })
      .lean();

    // Attach lead counts and employee counts
    const vendorIds = vendors.map((v) => v._id);
    const [leadCounts, empCounts] = await Promise.all([
      Lead.aggregate([
        { $match: { createdBy: { $in: vendorIds } } },
        { $group: { _id: '$createdBy', count: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { parent: { $in: vendorIds }, status: { $ne: 'inactive' } } },
        { $group: { _id: '$parent', count: { $sum: 1 } } },
      ]),
    ]);

    const leadCountMap = new Map(leadCounts.map((item) => [String(item._id), item.count]));
    const empCountMap = new Map(empCounts.map((item) => [String(item._id), item.count]));

    const enrichedVendors = vendors.map((vendor) => ({
      ...vendor,
      leadsCount: leadCountMap.get(String(vendor._id)) || 0,
      employeesCount: empCountMap.get(String(vendor._id)) || 0,
    }));

    return successResponse(res, 200, 'Vendors fetched successfully', enrichedVendors);
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new vendor
// @route   POST /api/vendors
// @access  Private (Admin only)
export const createVendor = async (req, res, next) => {
  try {
    if (!isAdminUser(req.user)) {
      return errorResponse(res, 403, 'Access denied. Admin access required.');
    }

    const {
      companyName,
      name,
      email,
      password,
      phone,
      indiamartApiKey,
      indiamartMobileNumber,
    } = req.body;

    if (!name || !email || !password || !companyName) {
      return errorResponse(res, 400, 'Company Name, Owner Name, Email, and Password are required.');
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return errorResponse(res, 400, 'A user or vendor with this email already exists.');
    }

    const hasIndiaMart = Boolean(indiamartApiKey && indiamartMobileNumber);

    const vendor = await User.create({
      companyName: companyName.trim(),
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      phone: phone ? phone.trim() : '',
      role: 'vendor',
      status: 'active',
      isActive: true,
      createdBy: req.user._id,
      indiamart: {
        apiKey: indiamartApiKey ? indiamartApiKey.trim() : '',
        mobileNumber: indiamartMobileNumber ? indiamartMobileNumber.trim() : '',
        syncStatus: hasIndiaMart ? 'connected' : 'disconnected',
        autoSync: true,
      },
    });

    return successResponse(res, 201, 'Vendor created successfully', {
      _id: vendor._id,
      companyName: vendor.companyName,
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone,
      role: vendor.role,
      indiamart: vendor.indiamart,
      status: vendor.status,
      createdAt: vendor.createdAt,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a vendor
// @route   PUT /api/vendors/:id
// @access  Private (Admin only)
export const updateVendor = async (req, res, next) => {
  try {
    if (!isAdminUser(req.user)) {
      return errorResponse(res, 403, 'Access denied. Admin access required.');
    }

    const { companyName, name, phone, status, password } = req.body;
    const vendor = await User.findOne({ _id: req.params.id, role: 'vendor' });

    if (!vendor) {
      return errorResponse(res, 404, 'Vendor not found.');
    }

    if (companyName) vendor.companyName = companyName.trim();
    if (name) vendor.name = name.trim();
    if (phone !== undefined) vendor.phone = phone.trim();
    if (status) {
      vendor.status = status;
      vendor.isActive = status !== 'inactive';
    }
    if (password && password.trim().length >= 6) {
      vendor.password = password.trim();
    }

    await vendor.save();

    return successResponse(res, 200, 'Vendor updated successfully', {
      _id: vendor._id,
      companyName: vendor.companyName,
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone,
      status: vendor.status,
      updatedAt: vendor.updatedAt,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete or deactivate a vendor
// @route   DELETE /api/vendors/:id
// @access  Private (Admin only)
export const deleteVendor = async (req, res, next) => {
  try {
    if (!isAdminUser(req.user)) {
      return errorResponse(res, 403, 'Access denied. Admin access required.');
    }

    const vendor = await User.findOne({ _id: req.params.id, role: 'vendor' });
    if (!vendor) {
      return errorResponse(res, 404, 'Vendor not found.');
    }

    vendor.status = 'inactive';
    vendor.isActive = false;
    await vendor.save();

    return successResponse(res, 200, 'Vendor deactivated successfully');
  } catch (error) {
    next(error);
  }
};
