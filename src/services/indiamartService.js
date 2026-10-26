import axios from 'axios';
import Lead from '../models/Lead.js';
import Company from '../models/Company.js';
import User from '../models/User.js';

const INDIAMART_BASE_URL = 'https://mapi.indiamart.com/wservce/crm/crmListing/v2/';

/**
 * Verify IndiaMART credentials by attempting a light test fetch
 * @param {string} mobileNumber 
 * @param {string} apiKey 
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export const verifyIndiaMartCredentials = async (mobileNumber, apiKey) => {
  if (!mobileNumber || !apiKey) {
    return { success: false, message: 'Mobile number and CRM Key are required' };
  }

  const cleanMobile = mobileNumber.toString().trim().replace(/[^0-9]/g, '').slice(-10);
  const cleanKey = apiKey.toString().trim();

  // Support for Demo / Testing Key without active seller account
  if (['DEMO_KEY', 'TEST_KEY', 'DEMO_INDIAMART'].includes(cleanKey.toUpperCase())) {
    return {
      success: true,
      message: 'IndiaMART connection verified successfully (Demo Mode).',
    };
  }

  try {
    const response = await axios.get(INDIAMART_BASE_URL, {
      params: {
        glusr_crm_key: cleanKey,
        glusr_crm_key_multiusers: cleanMobile,
      },
      timeout: 10000,
    });

    const data = response.data;
    const code = Number(data?.CODE || data?.code || 200);
    const status = String(data?.STATUS || data?.status || '').toUpperCase();
    const msg = data?.MESSAGE || data?.message || '';

    // If IndiaMART returns an auth or parameter failure
    if (code === 401 || code === 403 || status === 'FAILURE' || status === 'ERROR') {
      return {
        success: false,
        message: msg || 'Authentication failed. Please verify your CRM Key and Mobile Number.',
      };
    }

    return {
      success: true,
      message: 'IndiaMART connection verified successfully.',
    };
  } catch (error) {
    // If network error or API error
    const serverMsg = error.response?.data?.MESSAGE || error.response?.data?.message || error.message;
    return {
      success: false,
      message: `Failed to connect with IndiaMART: ${serverMsg}`,
    };
  }
};

/**
 * Sync leads for a single vendor
 * @param {string} vendorId 
 * @returns {Promise<{ fetched: number, created: number, skipped: number }>}
 */
export const syncVendorIndiaMartLeads = async (vendorId) => {
  const vendor = await User.findById(vendorId);
  if (!vendor || !vendor.indiamart?.apiKey || !vendor.indiamart?.mobileNumber) {
    throw new Error('Vendor does not have IndiaMART configuration configured');
  }

  const cleanMobile = vendor.indiamart.mobileNumber.toString().trim().replace(/[^0-9]/g, '').slice(-10);
  const cleanKey = vendor.indiamart.apiKey.toString().trim();

  try {
    let leadsRaw = [];

    // If testing with Demo Key, return simulated realistic IndiaMART buyer inquiries
    if (['DEMO_KEY', 'TEST_KEY', 'DEMO_INDIAMART'].includes(cleanKey.toUpperCase())) {
      leadsRaw = [
        {
          UNIQUEQUERYID: `DEMO-IM-${cleanMobile}-101`,
          SENDER_NAME: 'Vikram Patel',
          SENDER_MOBILE: '9823456789',
          SENDER_EMAIL: 'vikram.patel@pateltools.com',
          SENDER_COMPANY: 'Patel Industrial Supplies',
          QUERY_PRODUCT_NAME: 'CNC Milling Cutters & Tool Holders',
          QUERY_MESSAGE: 'Requirement for 50 sets of high-speed CNC milling cutters with fast dispatch.',
          SENDER_CITY: 'Ahmedabad',
          SENDER_STATE: 'Gujarat',
          SENDER_ADDRESS: 'GIDC Phase 2, Vatva',
        },
        {
          UNIQUEQUERYID: `DEMO-IM-${cleanMobile}-102`,
          SENDER_NAME: 'Sunita Rao',
          SENDER_MOBILE: '9711234567',
          SENDER_EMAIL: 'sunita@raoelectric.in',
          SENDER_COMPANY: 'Rao Electric Works',
          QUERY_PRODUCT_NAME: '3-Phase Heavy Induction Motors (10HP)',
          QUERY_MESSAGE: 'Please send latest price list and catalog for 10HP Induction Motors.',
          SENDER_CITY: 'Hyderabad',
          SENDER_STATE: 'Telangana',
          SENDER_ADDRESS: 'Industrial Estate, Sanath Nagar',
        },
        {
          UNIQUEQUERYID: `DEMO-IM-${cleanMobile}-103`,
          SENDER_NAME: 'Anil Deshmukh',
          SENDER_MOBILE: '9890123456',
          SENDER_EMAIL: 'anil.deshmukh@precisionauto.co',
          SENDER_COMPANY: 'Precision Auto Components',
          QUERY_PRODUCT_NAME: 'Hydraulic Valves & Fittings',
          QUERY_MESSAGE: 'Immediate requirement for bulk order of hydraulic control valves.',
          SENDER_CITY: 'Pune',
          SENDER_STATE: 'Maharashtra',
          SENDER_ADDRESS: 'Bhosari MIDC',
        },
      ];
    } else {
      const response = await axios.get(INDIAMART_BASE_URL, {
        params: {
          glusr_crm_key: cleanKey,
          glusr_crm_key_multiusers: cleanMobile,
        },
        timeout: 15000,
      });

      const data = response.data;
      leadsRaw = Array.isArray(data?.RESPONSE)
        ? data.RESPONSE
        : Array.isArray(data?.response)
          ? data.response
          : [];
    }

    let createdCount = 0;
    let skippedCount = 0;

    for (const item of leadsRaw) {
      const queryId = String(
        item.UNIQUEQUERYID || item.uniquequeryid || item.QUERY_ID || item.query_id || ''
      ).trim();

      if (!queryId) {
        continue;
      }

      // Check for duplicate lead by queryId in both Company and Lead models
      const [companyExists, leadExists] = await Promise.all([
        Company.exists({ queryId }),
        Lead.exists({ queryId }),
      ]);
      if (companyExists || leadExists) {
        skippedCount++;
        continue;
      }

      const senderName = (
        item.SENDER_NAME || item.sender_name || item.SENDERNAME || 'IndiaMART Buyer'
      ).trim();
      const senderPhone = (
        item.SENDER_MOBILE || item.sender_mobile || item.SENDERMOBILE || item.MOB || 'N/A'
      ).trim();
      const senderEmail = (
        item.SENDER_EMAIL || item.sender_email || item.SENDEREMAIL || ''
      ).trim();
      const senderCompany = (
        item.SENDER_COMPANY || item.sender_company || item.GLUSR_USR_COMPANYNAME || senderName
      ).trim();
      const productName = (
        item.QUERY_PRODUCT_NAME || item.query_product_name || item.PRODUCT_NAME || item.SUBJECT || 'General Inquiry'
      ).trim();
      const messageNotes = (
        item.QUERY_MESSAGE || item.query_message || item.ENQ_MESSAGE || item.SUBJECT || ''
      ).trim();

      const city = item.SENDER_CITY || item.sender_city || 'N/A';
      const state = item.SENDER_STATE || item.sender_state || '';
      const addressParts = [item.SENDER_ADDRESS || '', city, state].filter(Boolean);
      const address = addressParts.join(', ') || 'N/A';

      await Company.create({
        companyName: senderCompany || senderName,
        customerName: senderName,
        mobileNo: senderPhone,
        email1: senderEmail,
        products: productName,
        address1: address,
        city,
        state,
        country: 'India',
        website1: 'https://indiamart.com',
        leadSource: 'IndiaMART',
        queryId,
        messageNotes,
        leadStatus: 'New',
        createdBy: vendor._id,
        assignedTo: [vendor._id],
      });

      createdCount++;
    }

    // Update vendor sync timestamp
    vendor.indiamart.lastSyncAt = new Date();
    vendor.indiamart.syncStatus = 'connected';
    vendor.indiamart.lastError = '';
    await vendor.save();

    return {
      fetched: leadsRaw.length,
      created: createdCount,
      skipped: skippedCount,
    };
  } catch (error) {
    const errorMsg = error.response?.data?.MESSAGE || error.message;
    vendor.indiamart.lastError = errorMsg;
    vendor.indiamart.syncStatus = 'error';
    await vendor.save();
    throw error;
  }
};

/**
 * Sync leads for all vendors having autoSync enabled and connected status
 */
export const syncAllActiveVendors = async () => {
  try {
    const activeVendors = await User.find({
      'indiamart.apiKey': { $exists: true, $ne: '' },
      'indiamart.mobileNumber': { $exists: true, $ne: '' },
      'indiamart.autoSync': true,
      status: { $ne: 'inactive' },
    }).select('_id name companyName indiamart');

    if (!activeVendors.length) {
      return { totalVendors: 0, totalCreated: 0 };
    }

    let totalCreated = 0;

    for (const vendor of activeVendors) {
      try {
        const result = await syncVendorIndiaMartLeads(vendor._id);
        totalCreated += result.created;
      } catch (err) {
        console.error(`[IndiaMART Sync] Failed for vendor ${vendor.name} (${vendor._id}):`, err.message);
      }
    }

    return {
      totalVendors: activeVendors.length,
      totalCreated,
    };
  } catch (error) {
    console.error('[IndiaMART Sync All] Error:', error.message);
    throw error;
  }
};
