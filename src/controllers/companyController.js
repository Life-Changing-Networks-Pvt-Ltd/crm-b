import Company from '../models/Company.js';
import { cancelLeadFollowUpReminders } from '../services/followUpReminderService.js';
import LeadStatusHistory from '../models/LeadStatusHistory.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { isAdminUser } from '../utils/hierarchy.js';
import { logActivity } from '../utils/activity.js';
import { syncDemoFollowUpReminder, cancelDemoFollowUpReminder } from '../services/demoFollowUpReminderService.js';
import { invalidateLeadMetricsCaches } from '../services/cacheService.js';
import { escapeRegex, pagedData, paginationMeta, parsePagination, safeSort } from '../services/listQueryService.js';
import { resolveLeadVisibility } from '../services/leadAccessService.js';
import { userHasPermission } from '../services/accessControlService.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { sendAutomatedLeadStatusNotifications } from '../services/leadStatusNotificationService.js';
import { parseStatusDetails } from '../utils/statusDetails.js';
import { buildCompanyStatusPeriodFilter } from '../services/leadStatsService.js';

const normalizeAssignees = (assignedTo) => {
  if (!assignedTo) return [];
  return Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : [assignedTo];
};

const isAssignedToUser = (lead, userId) => normalizeAssignees(lead.assignedTo)
  .some((assigneeId) => assigneeId?.toString() === userId.toString());

// @desc    Get all companies
// @route   GET /api/companies
// @access  Private
export const getCompanies = async (req, res, next) => {
  try {
    const { query } = await resolveLeadVisibility(req.user);

    const companies = await Company.find(query)
      .populate('createdBy', 'name role email')
      .sort({ createdAt: -1 })
      .lean();
    
    return successResponse(res, 200, 'Companies fetched successfully', companies);
  } catch (error) {
    next(error);
  }
};

export const getCompaniesPaged = async (req, res, next) => {
  try {
    const { page, limit, skip, search } = parsePagination(req.query);
    const { query: visibility } = await resolveLeadVisibility(req.user);
    const filter = { ...visibility };
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { companyName: pattern },
        { customerName: pattern },
        { email1: pattern },
        { mobileNo: pattern },
        { city: pattern },
      ];
    }
    if (req.query.status && req.query.status !== 'all') {
      filter.leadStatus = req.query.status;
      Object.assign(filter, buildCompanyStatusPeriodFilter(req.query.status, req.query));
    }
    if (req.query.city && req.query.city !== 'all') filter.city = req.query.city;

    const [items, total, cities] = await Promise.all([
      Company.find(filter)
        .select('companyName customerName customerDesignation email1 mobileNo website1 city country leadStatus followUpRequired followUpDateTime followUpType followUpPriority followUpReminder followTypeDate scheduledDateTime statusDetails.demoFollowUpDateTime createdBy assignedTo createdAt')
        .populate('createdBy', 'name role')
        .populate('assignedTo', 'name')
        .sort(safeSort(req.query, ['createdAt', 'companyName', 'city']))
        .skip(skip)
        .limit(limit)
        .lean(),
      Company.countDocuments(filter),
      Company.distinct('city', visibility),
    ]);
    return successResponse(res, 200, 'Companies page fetched successfully', pagedData(
      items,
      paginationMeta({ page, limit, total }),
      { cities: cities.filter(Boolean).sort() },
    ));
  } catch (error) {
    next(error);
  }
};

export const getCompanyOptions = async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const { query: visibility } = await resolveLeadVisibility(req.user);
    const filter = { ...visibility };
    if (search) filter.companyName = new RegExp(escapeRegex(search), 'i');
    const companies = await Company.find(filter)
      .select('companyName customerName email1 mobileNo')
      .sort({ companyName: 1 })
      .lean();
    return successResponse(res, 200, 'Company options fetched successfully', companies);
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new company
// @route   POST /api/companies
// @access  Private
export const createCompany = async (req, res, next) => {
  try {
    const { 
      companyName, customerName, customerDesignation, email1, email2, 
      mobileNo, phoneNo, products, businessType, address1, address2, 
      city, state, country, website1, website2, followTypeDate, followType,
      leadStatus, assignedTo, messageNotes, scheduledDateTime, statusDetails
    } = req.body;

    const finalLeadStatus = scheduledDateTime ? 'Demo Scheduled' : leadStatus || 'New';
    if (
      (scheduledDateTime || finalLeadStatus !== 'New')
      && !userHasPermission(req.access, PERMISSIONS.LEADS_CHANGE_STATUS)
    ) {
      return errorResponse(res, 403, 'You do not have permission to set the lead status');
    }
    if (assignedTo && String(assignedTo) !== String(req.user._id)
      && !userHasPermission(req.access, PERMISSIONS.LEADS_ASSIGN)) {
      return errorResponse(res, 403, 'You do not have permission to assign leads');
    }

    let parsedStatusDetails;
    if (statusDetails !== undefined || finalLeadStatus === 'Demo follow-up') {
      try {
        parsedStatusDetails = parseStatusDetails(finalLeadStatus, statusDetails);
      } catch (error) {
        return errorResponse(res, 400, error.message);
      }
    }
    const effectiveScheduledDateTime = parsedStatusDetails?.demoDateTime || scheduledDateTime;

    const company = await Company.create({
      companyName,
      customerName,
      customerDesignation,
      email1,
      email2,
      mobileNo,
      phoneNo,
      products,
      businessType,
      address1,
      address2,
      city,
      state,
      country,
      website1,
      website2,
      followTypeDate,
      scheduledDateTime: effectiveScheduledDateTime,
      followType,
      messageNotes,
      leadStatus: finalLeadStatus,
      ...(parsedStatusDetails ? {
        statusDetails: {
          ...parsedStatusDetails,
          savedBy: req.user._id,
          savedAt: new Date(),
        },
      } : {}),
      assignedTo: [assignedTo || req.user._id],
      createdBy: req.user._id // Taken from authMiddleware
    });

    if (finalLeadStatus === 'Demo follow-up') await syncDemoFollowUpReminder(company, req.user._id);

    await LeadStatusHistory.create({
      lead: company._id,
      leadModel: 'Company',
      oldStatus: null,
      newStatus: finalLeadStatus,
      changedBy: req.user._id,
    });

    await logActivity({
      user: req.user._id,
      actionType: 'lead_created',
      description: `Created company lead ${company.companyName}`,
      entityType: 'Company',
      entityId: company._id,
    });

    await sendAutomatedLeadStatusNotifications({
      leadType: 'Company',
      lead: company,
      status: finalLeadStatus,
      actorUserId: req.user._id,
      trigger: 'lead_created',
    });

    const populatedCompany = await Company.findById(company._id).populate('createdBy', 'name role email').populate('assignedTo', 'name role email');

    await invalidateLeadMetricsCaches();
    return successResponse(res, 201, 'Company created successfully', populatedCompany);
  } catch (error) {
    next(error);
  }
};

// @desc    Get company by ID
// @route   GET /api/companies/:id
// @access  Private
export const getCompanyById = async (req, res, next) => {
  try {
    const { query: visibility } = await resolveLeadVisibility(req.user);
    const company = await Company.findOne({ _id: req.params.id, ...visibility })
      .populate('createdBy', 'name role email');
    
    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    return successResponse(res, 200, 'Company fetched successfully', company);
  } catch (error) {
    next(error);
  }
};

// @desc    Update a company
// @route   PUT /api/companies/:id
// @access  Private
export const updateCompany = async (req, res, next) => {
  try {
    const { query: visibility } = await resolveLeadVisibility(req.user);
    let company = await Company.findOne({ _id: req.params.id, ...visibility });

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    const { 
      companyName, customerName, customerDesignation, email1, email2, 
      mobileNo, phoneNo, products, businessType, address1, address2, 
      city, state, country, website1, website2, followTypeDate, followType,
      leadStatus, assignedTo, messageNotes, scheduledDateTime, statusDetails
    } = req.body;
    const oldStatus = company.leadStatus;
    const finalLeadStatus = scheduledDateTime ? 'Demo Scheduled' : leadStatus;
    if (
      finalLeadStatus && oldStatus !== finalLeadStatus
      && !userHasPermission(req.access, PERMISSIONS.LEADS_CHANGE_STATUS)
    ) {
      return errorResponse(res, 403, 'You do not have permission to change lead status');
    }
    if (assignedTo && !normalizeAssignees(company.assignedTo).some((id) => String(id) === String(assignedTo))
      && !userHasPermission(req.access, PERMISSIONS.LEADS_ASSIGN)) {
      return errorResponse(res, 403, 'You do not have permission to assign leads');
    }

    const update = {
      $set: {
        companyName, customerName, customerDesignation, email1, email2,
        mobileNo, phoneNo, products, businessType, address1, address2,
        city, state, country, website1, website2, followTypeDate, followType,
        messageNotes, scheduledDateTime,
        leadStatus: finalLeadStatus || oldStatus,
      },
    };
    if ((finalLeadStatus || oldStatus) === 'Demo follow-up' && (statusDetails !== undefined || oldStatus !== 'Demo follow-up')) {
      if (!userHasPermission(req.access, PERMISSIONS.LEADS_CHANGE_STATUS)) {
        return errorResponse(res, 403, 'You do not have permission to change lead status');
      }
      try {
        update.$set.statusDetails = {
          ...parseStatusDetails('Demo follow-up', statusDetails),
          savedBy: req.user._id,
          savedAt: new Date(),
        };
      } catch (error) {
        return errorResponse(res, 400, error.message);
      }
    }
    if (assignedTo) update.$addToSet = { assignedTo };
    company = await Company.findOneAndUpdate(
      { _id: req.params.id, ...visibility },
      update,
      { new: true, runValidators: true },
    )
      .populate('createdBy', 'name role email')
      .populate('assignedTo', 'name role email');

    if (oldStatus === 'Demo follow-up' || finalLeadStatus === 'Demo follow-up') {
      if (update.$set.statusDetails || company.leadStatus !== 'Demo follow-up') {
        await syncDemoFollowUpReminder(company, req.user._id);
      }
    }

    if (finalLeadStatus && oldStatus !== finalLeadStatus) {
      await LeadStatusHistory.create({
        lead: company._id,
        leadModel: 'Company',
        oldStatus,
        newStatus: finalLeadStatus,
        changedBy: req.user._id,
      });

      await sendAutomatedLeadStatusNotifications({
        leadType: 'Company',
        lead: company,
        status: finalLeadStatus,
        actorUserId: req.user._id,
        trigger: 'status_changed',
      });
    }

    await invalidateLeadMetricsCaches();
    return successResponse(res, 200, 'Company updated successfully', company);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a company
// @route   DELETE /api/companies/:id
// @access  Private
export const deleteCompany = async (req, res, next) => {
  try {
    const { query: visibility } = await resolveLeadVisibility(req.user);
    const company = await Company.findOne({ _id: req.params.id, ...visibility });

    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' });
    }

    await company.deleteOne();
    await cancelLeadFollowUpReminders([company._id]);

    await invalidateLeadMetricsCaches();
    return successResponse(res, 200, 'Company deleted successfully');
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk create companies from Excel import
// @route   POST /api/companies/bulk
// @access  Private
export const bulkCreateCompanies = async (req, res, next) => {
  try {
    const companiesData = req.body.data;
    
    if (!companiesData || !Array.isArray(companiesData) || companiesData.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid data provided for bulk import' });
    }

    // Map through array and add createdBy field
    const companiesToInsert = companiesData.map(item => ({
      name: item.name || item.Name,
      email: item.email || item.Email || '',
      phone: item.phone || item.Phone || '',
      industry: item.industry || item.Industry || '',
      type: item.type || item.Type || 'Prospect',
      revenue: item.revenue || item.Revenue ? Number(item.revenue || item.Revenue) : 0,
      address: item.address || item.Address || '',
      createdBy: req.user._id,
      assignedTo: [req.user._id],
    })).filter(c => c.name); // Ensure name exists

    if (companiesToInsert.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid company records found to import' });
    }

    const result = await Company.insertMany(companiesToInsert);

    await invalidateLeadMetricsCaches();
    return successResponse(res, 201, `${result.length} Companies imported successfully`, { count: result.length });
  } catch (error) {
    next(error);
  }
};
