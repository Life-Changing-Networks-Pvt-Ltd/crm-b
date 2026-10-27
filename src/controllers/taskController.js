import Task from '../models/Task.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { escapeRegex, pagedData, paginationMeta, parseDateParam, parsePagination, safeSort } from '../services/listQueryService.js';
import { resolveUserDataScope } from '../services/dataScopeService.js';
import {
  getAccountUserIds,
  resolveAccountOwnerId,
  userHasPermission,
} from '../services/accessControlService.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
  sendTaskAssignedEmail,
  sendTaskCompletedAdminEmail,
} from '../services/taskEmailService.js';
import { parseFutureTaskDueDate } from '../services/taskDueDateService.js';

const buildTaskVisibilityFilter = async (user, query = {}, access = null) => {
  const visibility = await resolveUserDataScope(user, 'tasks', access);
  let baseFilter = {
    archivedAt: query.archived === 'true' || query.archived === true
      ? { $ne: null }
      : null,
  };

  if (visibility.scope === 'none') {
    baseFilter._id = { $exists: false };
  } else if (visibility.scope !== 'all') {
    baseFilter.$or = [
      { assignedTo: { $in: visibility.userIds } },
      { createdBy: { $in: visibility.userIds } },
    ];
  }

  if (query.myTasks === 'true' || query.myTasks === true) {
    baseFilter = { $and: [baseFilter, { assignedTo: user._id }] };
  } else if (query.assignedTo && query.assignedTo !== 'all') {
    if (!mongoose.isValidObjectId(query.assignedTo)) {
      baseFilter._id = { $exists: false };
      return baseFilter;
    }
    baseFilter = { $and: [baseFilter, { assignedTo: query.assignedTo }] };
  }

  if (query.department && query.department !== 'all') {
    baseFilter.department = query.department;
  }

  if (query.taskType && query.taskType !== 'all') {
    baseFilter.taskType = query.taskType;
  }

  return baseFilter;
};

const addActivity = (task, userId, action, message) => {
  task.activity.push({ user: userId, action, message, createdAt: new Date() });
};

const validateAssignableUser = async (actor, candidateId) => {
  if (!mongoose.isValidObjectId(candidateId)) {
    return { valid: false, message: 'Selected employee is invalid' };
  }
  const ownerId = await resolveAccountOwnerId(actor);
  const accountUserIds = await getAccountUserIds(ownerId);
  if (!accountUserIds.map(String).includes(String(candidateId))) {
    return { valid: false, message: 'Selected employee is outside your account' };
  }
  const employee = await User.findOne({
    _id: candidateId,
    isActive: true,
    role: { $not: /^admin$/i },
  }).select('_id name email role').lean();
  if (!employee) {
    return { valid: false, message: 'Selected employee is inactive or unavailable' };
  }
  return { valid: true, employee };
};

const allowedEmployeeTransitions = Object.freeze({
  Todo: ['In Progress', 'Blocked'],
  'In Progress': ['In Review', 'Blocked'],
  'In Review': ['In Progress'],
  Blocked: ['In Progress'],
  Done: [],
});

export const validateTaskStatusTransition = ({ task, nextStatus, actorId, canReview }) => {
  if (!nextStatus || nextStatus === task.status) return { valid: true };
  const actorIsAssignee = String(task.assignedTo || '') === String(actorId);

  if (nextStatus === 'Done') {
    if (!canReview) return { valid: false, message: 'Only an authorized reviewer can approve a task' };
    if (task.status !== 'In Review') return { valid: false, message: 'A task must be submitted for review before approval' };
    return { valid: true };
  }

  if (task.status === 'Done' && !canReview) {
    return { valid: false, message: 'Only an authorized reviewer can reopen a completed task' };
  }

  if (canReview) return { valid: true };
  if (!actorIsAssignee) {
    return { valid: false, message: 'Only the assigned employee can update task progress' };
  }
  if (!(allowedEmployeeTransitions[task.status] || []).includes(nextStatus)) {
    return { valid: false, message: `Task cannot move from ${task.status} to ${nextStatus}` };
  }
  return { valid: true };
};

const taskIsInScope = async (task, user, access) => {
  const visibility = await resolveUserDataScope(user, 'tasks', access);
  if (visibility.scope === 'all') return true;
  if (visibility.scope === 'none') return false;

  const visibleIds = new Set(visibility.userIds.map(String));
  return visibleIds.has(String(task.createdBy))
    || (task.assignedTo && visibleIds.has(String(task.assignedTo)));
};

// @desc    Get all tasks for logged in user (with role & hierarchy scoping)
// @route   GET /api/tasks
// @access  Private
export const getTasks = async (req, res, next) => {
  try {
    const filter = await buildTaskVisibilityFilter(req.user, req.query, req.access);

    const tasks = await Task.find(filter)
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email role')
      .populate('comments.user', 'name email role')
      .populate('activity.user', 'name email role')
      .sort({ createdAt: -1 })
      .lean();

    return successResponse(res, 200, 'Tasks fetched successfully', tasks);
  } catch (error) {
    next(error);
  }
};

export const getTasksPaged = async (req, res, next) => {
  try {
    const { page, limit, skip, search } = parsePagination(req.query);
    let filter = await buildTaskVisibilityFilter(req.user, req.query, req.access);

    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      const searchConditions = [{ title: pattern }, { description: pattern }];
      if (filter.$or) {
        const visibilityConditions = filter.$or;
        delete filter.$or;
        filter = { $and: [filter, { $or: visibilityConditions }, { $or: searchConditions }] };
      } else {
        filter.$or = searchConditions;
      }
    }

    if (req.query.status && req.query.status !== 'all') {
      filter.status = req.query.status;
    }
    if (req.query.priority && req.query.priority !== 'all') {
      filter.priority = req.query.priority;
    }
    if (req.query.startDate || req.query.endDate) {
      const startDate = parseDateParam(req.query.startDate);
      const endDate = parseDateParam(req.query.endDate, { endOfDay: true });
      if ((req.query.startDate && !startDate) || (req.query.endDate && !endDate)) {
        return errorResponse(res, 400, 'Invalid task date range');
      }
      filter.dueDate = {};
      if (startDate) filter.dueDate.$gte = startDate;
      if (endDate) filter.dueDate.$lte = endDate;
    }

    const [items, total] = await Promise.all([
      Task.find(filter)
        .populate('assignedTo', 'name email role')
        .populate('createdBy', 'name email role')
        .populate('comments.user', 'name email role')
        .populate('activity.user', 'name email role')
        .sort(safeSort(req.query, ['createdAt', 'dueDate', 'title', 'priority', 'status']))
        .skip(skip)
        .limit(limit)
        .lean(),
      Task.countDocuments(filter),
    ]);

    return successResponse(res, 200, 'Tasks page fetched successfully', pagedData(
      items,
      paginationMeta({ page, limit, total }),
    ));
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new task
// @route   POST /api/tasks
// @access  Private
export const createTask = async (req, res, next) => {
  try {
    const {
      title,
      description,
      priority,
      dueDate,
      assignedTo,
      department,
      taskType,
    } = req.body;

    if (!title || !title.trim()) {
      return errorResponse(res, 400, 'Task title is required');
    }

    const parsedDueDate = parseFutureTaskDueDate(dueDate);
    if (!parsedDueDate.valid) {
      return errorResponse(res, 400, parsedDueDate.message);
    }

    const assignedToId = assignedTo && assignedTo !== 'unassigned' && assignedTo !== 'none'
      ? assignedTo
      : null;

    if (!assignedToId) {
      return errorResponse(res, 400, 'Please select an employee to assign this task');
    }

    if (
      assignedToId
      && String(assignedToId) !== String(req.user._id)
      && !userHasPermission(req.access, PERMISSIONS.TASKS_ASSIGN)
    ) {
      return errorResponse(res, 403, 'You do not have permission to assign tasks to other users');
    }

    const assigneeCheck = await validateAssignableUser(req.user, assignedToId);
    if (!assigneeCheck.valid) {
      return errorResponse(res, 400, assigneeCheck.message);
    }

    const task = await Task.create({
      title: title.trim(),
      description: description || '',
      status: 'Todo',
      priority: priority || 'Medium',
      dueDate: parsedDueDate.date || null,
      assignedTo: assignedToId,
      department: department || 'General',
      taskType: taskType || 'Task',
      createdBy: req.user._id,
      activity: [{
        user: req.user._id,
        action: 'created',
        message: `Task created and assigned to ${assigneeCheck.employee.name}`,
        createdAt: new Date(),
      }],
    });

    if (assignedToId && assignedToId.toString() !== req.user._id.toString()) {
      try {
        await Notification.create({
          user: assignedToId,
          title: 'New Task Assigned',
          message: `${req.user.name || 'Admin'} assigned you a task: "${title.trim()}"`,
          type: 'info',
        });
      } catch (notifErr) {
        console.error('Task notification error:', notifErr.message);
      }
    }

    const populatedTask = await Task.findById(task._id)
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email role')
      .populate('activity.user', 'name email role')
      .lean();

    if (populatedTask.assignedTo?.email) {
      void sendTaskAssignedEmail({ task: populatedTask });
    }

    return successResponse(res, 201, 'Task created successfully', populatedTask);
  } catch (error) {
    next(error);
  }
};

// @desc    Update a task
// @route   PUT /api/tasks/:id
// @access  Private
export const updateTask = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return errorResponse(res, 400, 'Invalid task id');
    }
    const task = await Task.findById(req.params.id);

    if (!task) {
      return errorResponse(res, 404, 'Task not found');
    }

    if (!await taskIsInScope(task, req.user, req.access)) {
      return errorResponse(res, 403, 'Not authorized to update this task');
    }

    const {
      title,
      description,
      status,
      priority,
      dueDate,
      assignedTo,
      department,
      taskType,
      comment,
      statusNote,
    } = req.body;

    const oldStatus = task.status;
    const oldAssignee = task.assignedTo?.toString();
    const canEdit = userHasPermission(req.access, PERMISSIONS.TASKS_EDIT);
    const canAssign = userHasPermission(req.access, PERMISSIONS.TASKS_ASSIGN);
    const canReview = userHasPermission(req.access, PERMISSIONS.TASKS_REVIEW);
    const editRequested = [
      title,
      description,
      priority,
      dueDate,
      department,
      taskType,
    ].some((value) => value !== undefined);

    if (editRequested && !canEdit) {
      return errorResponse(res, 403, 'You do not have permission to edit tasks');
    }
    if (status !== undefined && !canEdit && !canReview) {
      return errorResponse(res, 403, 'You do not have permission to update task progress');
    }
    if (assignedTo !== undefined && !canAssign) {
      return errorResponse(res, 403, 'You do not have permission to assign tasks');
    }

    if (title !== undefined && (!String(title).trim())) {
      return errorResponse(res, 400, 'Task title is required');
    }

    const transitionCheck = validateTaskStatusTransition({
      task,
      nextStatus: status,
      actorId: req.user._id,
      canReview,
    });
    if (!transitionCheck.valid) {
      return errorResponse(res, 403, transitionCheck.message);
    }

    if (status === 'Blocked' && oldStatus !== 'Blocked' && !String(statusNote || '').trim()) {
      return errorResponse(res, 400, 'Please provide a reason for blocking this task');
    }
    if (oldStatus === 'In Review' && status === 'In Progress' && canReview && !String(statusNote || '').trim()) {
      return errorResponse(res, 400, 'Please explain the requested changes');
    }

    const parsedDueDate = parseFutureTaskDueDate(dueDate);
    if (!parsedDueDate.valid) {
      return errorResponse(res, 400, parsedDueDate.message);
    }

    if (title !== undefined && title.trim() !== task.title) {
      addActivity(task, req.user._id, 'title_changed', 'Task title updated');
      task.title = title.trim();
    }
    if (description !== undefined && description !== task.description) {
      addActivity(task, req.user._id, 'description_changed', 'Task description updated');
      task.description = description;
    }
    if (priority !== undefined && priority !== task.priority) {
      addActivity(task, req.user._id, 'priority_changed', `Priority changed from ${task.priority} to ${priority}`);
      task.priority = priority;
    }
    if (parsedDueDate.provided) task.dueDate = parsedDueDate.date;
    if (department !== undefined && department !== task.department) {
      addActivity(task, req.user._id, 'department_changed', `Department changed from ${task.department} to ${department}`);
      task.department = department;
    }
    if (taskType !== undefined && taskType !== task.taskType) {
      addActivity(task, req.user._id, 'type_changed', `Type changed from ${task.taskType} to ${taskType}`);
      task.taskType = taskType;
    }

    if (assignedTo !== undefined) {
      const assignedToId = assignedTo && assignedTo !== 'unassigned' && assignedTo !== 'none'
        ? assignedTo
        : null;
      if (!assignedToId) {
        return errorResponse(res, 400, 'An active task must be assigned to an employee');
      }
      const assigneeCheck = await validateAssignableUser(req.user, assignedToId);
      if (!assigneeCheck.valid) {
        return errorResponse(res, 400, assigneeCheck.message);
      }
      if (String(assignedToId) !== String(oldAssignee)) {
        addActivity(task, req.user._id, 'assigned', `Task assigned to ${assigneeCheck.employee.name}`);
        task.assignedTo = assignedToId;
      }
    }

    if (parsedDueDate.provided) {
      addActivity(task, req.user._id, 'deadline_changed', parsedDueDate.date
        ? `Deadline changed to ${parsedDueDate.date.toISOString()}`
        : 'Deadline removed');
    }

    if (status !== undefined && status !== oldStatus) {
      task.status = status;
      const note = String(statusNote || '').trim();
      addActivity(
        task,
        req.user._id,
        'status_changed',
        `Status changed from ${oldStatus} to ${status}${note ? `: ${note}` : ''}`,
      );
      if (status === 'Blocked') task.blockedReason = String(statusNote).trim();
      if (status !== 'Blocked') task.blockedReason = '';
      if (status === 'In Review') {
        task.submittedAt = new Date();
        task.submittedBy = req.user._id;
        task.reviewDecision = '';
        task.reviewComment = '';
      }
      if (status === 'Done') {
        task.reviewedAt = new Date();
        task.reviewedBy = req.user._id;
        task.reviewDecision = 'approved';
        task.reviewComment = String(statusNote || '').trim();
        task.completedAt = new Date();
      }
      if (oldStatus === 'In Review' && status === 'In Progress' && canReview) {
        task.reviewedAt = new Date();
        task.reviewedBy = req.user._id;
        task.reviewDecision = 'changes_requested';
        task.reviewComment = String(statusNote).trim();
      }
      if (oldStatus === 'Done' && status !== 'Done') task.completedAt = null;
    }

    // Add comment if provided
    if (comment && typeof comment === 'string' && comment.trim()) {
      task.comments.push({
        user: req.user._id,
        text: comment.trim(),
        createdAt: new Date(),
      });
      addActivity(task, req.user._id, 'comment_added', 'Comment added');
    }

    await task.save();

    // Notify newly assigned user
    const newAssignee = task.assignedTo?.toString();
    if (newAssignee && newAssignee !== oldAssignee && newAssignee !== req.user._id.toString()) {
      try {
        await Notification.create({
          user: task.assignedTo,
          title: 'Task Assigned',
          message: `${req.user.name || 'Admin'} assigned you a task: "${task.title}"`,
          type: 'info',
        });
      } catch (notifErr) {
        console.error('Task notification error:', notifErr.message);
      }
    }

    // Notify the creator when the assignee submits work for review.
    const actorIsAssignee = oldAssignee === String(req.user._id);
    const actorIsCreator = String(task.createdBy) === String(req.user._id);
    if (status === 'In Review' && oldStatus !== 'In Review' && actorIsAssignee && !actorIsCreator) {
      try {
        await Notification.create({
          user: task.createdBy,
          title: 'Task Submitted for Review',
          message: `${req.user.name || 'Assignee'} submitted "${task.title}" for review.`,
          type: 'success',
        });
      } catch (notifErr) {
        console.error('Task notification error:', notifErr.message);
      }
    }

    if (status === 'Done' && oldStatus === 'In Review' && newAssignee) {
      try {
        await Notification.create({
          user: task.assignedTo,
          title: 'Task Approved',
          message: `${req.user.name || 'Reviewer'} approved "${task.title}".`,
          type: 'success',
        });
      } catch (notifErr) {
        console.error('Task notification error:', notifErr.message);
      }
    }

    if (status === 'In Progress' && oldStatus === 'In Review' && canReview && newAssignee) {
      try {
        await Notification.create({
          user: task.assignedTo,
          title: 'Task Changes Requested',
          message: `${req.user.name || 'Reviewer'} requested changes on "${task.title}".`,
          type: 'warning',
        });
      } catch (notifErr) {
        console.error('Task notification error:', notifErr.message);
      }
    }

    const populatedTask = await Task.findById(task._id)
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email role')
      .populate('comments.user', 'name email role')
      .populate('activity.user', 'name email role')
      .populate('submittedBy reviewedBy archivedBy', 'name email role')
      .lean();

    if (newAssignee && newAssignee !== oldAssignee && populatedTask.assignedTo?.email) {
      void sendTaskAssignedEmail({ task: populatedTask });
    }
    if (status === 'In Review' && oldStatus !== 'In Review' && actorIsAssignee && !actorIsCreator) {
      void sendTaskCompletedAdminEmail({
        task: populatedTask,
        employee: req.user,
        completedAt: task.submittedAt || new Date(),
      });
    }

    return successResponse(res, 200, 'Task updated successfully', populatedTask);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a task
// @route   DELETE /api/tasks/:id
// @access  Private
export const deleteTask = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return errorResponse(res, 400, 'Invalid task id');
    }
    const task = await Task.findById(req.params.id);

    if (!task) {
      return errorResponse(res, 404, 'Task not found');
    }

    if (!await taskIsInScope(task, req.user, req.access)) {
      return errorResponse(res, 403, 'Not authorized to delete this task');
    }

    task.archivedAt = new Date();
    task.archivedBy = req.user._id;
    addActivity(task, req.user._id, 'archived', 'Task archived');
    await task.save();

    return successResponse(res, 200, 'Task archived successfully');
  } catch (error) {
    next(error);
  }
};
