import Customer from '../models/Customer.js';
import Company from '../models/Company.js';
import User from '../models/User.js';
import CallLog from '../models/CallLog.js';
import LeadStatusHistory from '../models/LeadStatusHistory.js';
import { resolveUserDataScope } from './dataScopeService.js';
import mongoose from 'mongoose';

const aggregateLeadOwnership = (Model, userIds) => Model.aggregate([
  {
    $project: {
      owners: {
        $setUnion: [
          [{ $ifNull: ['$createdBy', null] }],
          { $ifNull: ['$assignedTo', []] },
        ],
      },
    },
  },
  { $unwind: '$owners' },
  { $match: { owners: { $in: userIds } } },
  { $group: { _id: '$owners', totalLeads: { $sum: 1 } } },
]);

export const getDashboardAnalytics = async (user, access) => {
  const [leadVisibility, callVisibility] = await Promise.all([
    resolveUserDataScope(user, 'leads', access),
    resolveUserDataScope(user, 'calls', access),
  ]);
  const rawLeadUserIds = leadVisibility.scope === 'all'
    ? (await User.find({}).distinct('_id'))
    : leadVisibility.userIds;
  const rawCallUserIds = callVisibility.scope === 'all'
    ? (await User.find({}).distinct('_id'))
    : callVisibility.userIds;
  const asObjectIds = (ids) => ids
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const leadUserIds = asObjectIds(rawLeadUserIds);
  const callUserIds = asObjectIds(rawCallUserIds);
  const userIds = Array.from(new Set([...leadUserIds, ...callUserIds].map(String)));
  const [callAgg, teamUsers, statusTrend, customerOwnership, companyOwnership, callsByUser] = await Promise.all([
    CallLog.aggregate([
      { $match: { calledBy: { $in: callUserIds } } },
      { $group: { _id: null, totalCalls: { $sum: 1 }, averageQualityScore: { $avg: '$aiQualityScore' } } },
    ]),
    User.find({ _id: { $in: userIds } }).select('name role parent').lean(),
    LeadStatusHistory.aggregate([
      {
        $match: {
          changedBy: { $in: leadUserIds },
          newStatus: { $in: ['Demo Scheduled', 'Demo follow-up', 'Follow Up', 'Committed', 'Converted', 'Not Interested'] },
        },
      },
      {
        $group: {
          _id: {
            status: '$newStatus',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$changedAt' } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]),
    aggregateLeadOwnership(Customer, leadUserIds),
    aggregateLeadOwnership(Company, leadUserIds),
    CallLog.aggregate([
      { $match: { calledBy: { $in: callUserIds } } },
      { $group: { _id: '$calledBy', totalCalls: { $sum: 1 }, averageQualityScore: { $avg: '$aiQualityScore' } } },
    ]),
  ]);

  const leadCounts = new Map();
  [...customerOwnership, ...companyOwnership].forEach(({ _id, totalLeads }) => {
    const key = _id.toString();
    leadCounts.set(key, (leadCounts.get(key) || 0) + totalLeads);
  });
  const callCounts = new Map(callsByUser.map((item) => [item._id.toString(), item]));

  return {
    callActivity: {
      totalCalls: callAgg[0]?.totalCalls || 0,
      averageQualityScore: Math.round((callAgg[0]?.averageQualityScore || 0) * 10) / 10,
    },
    teamBreakdown: teamUsers.map((teamUser) => {
      const calls = callCounts.get(teamUser._id.toString());
      return {
        userId: teamUser._id,
        name: teamUser.name,
        role: teamUser.role,
        totalLeads: leadCounts.get(teamUser._id.toString()) || 0,
        totalCalls: calls?.totalCalls || 0,
        averageQualityScore: Math.round((calls?.averageQualityScore || 0) * 10) / 10,
      };
    }).sort((a, b) => b.totalLeads - a.totalLeads),
    statusTrend: statusTrend.map((item) => ({
      date: item._id.day,
      status: item._id.status,
      count: item.count,
    })),
  };
};
