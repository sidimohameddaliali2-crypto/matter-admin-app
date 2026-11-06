import express from 'express';
import Employee from '../models/Employee.js';
import LeaveRequest from '../models/LeaveRequest.js';
import { protect, manager } from '../middleware/auth.js';

import { requireStaffPermission } from '../services/staffAccessPolicy.js';

const router = express.Router();

router.use(protect, manager, requireStaffPermission('employees'));

function countInclusiveDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(0, 0, 0, 0);
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

// GET /api/employees - list employees
router.get('/', async (req, res) => {
  try {
    const { search, department, status, page = 1, limit = 10 } = req.query;

    const query = {};
    if (status && status !== 'all') query.status = status;
    if (department && department !== 'all') query.department = department;
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const employees = await Employee.find(query)
      .populate('userId', 'email profile.firstName profile.lastName role')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Employee.countDocuments(query);

    res.json({
      employees,
      totalPages: Math.ceil(total / limit),
      currentPage: Number(page),
      total
    });
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// POST /api/employees - create employee profile
router.post('/', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, position, department, hireDate,
      userId, leaveBalances
    } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ message: 'firstName and lastName are required' });
    }

    const employee = await Employee.create({
      firstName, lastName, email, phone, position, department, hireDate,
      userId: userId || undefined,
      leaveBalances,
      createdBy: req.user.id
    });

    res.status(201).json(employee);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'This user account is already linked to another employee profile' });
    }
    console.error('Create employee error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /api/employees/leave-requests - cross-employee list (pending approvals, etc.)
router.get('/leave-requests', async (req, res) => {
  try {
    const { status, type, employee } = req.query;

    const query = {};
    if (status && status !== 'all') query.status = status;
    if (type && type !== 'all') query.type = type;
    if (employee) query.employee = employee;

    const leaveRequests = await LeaveRequest.find(query)
      .populate('employee', 'firstName lastName department position')
      .populate('requestedBy', 'email profile.firstName profile.lastName')
      .populate('approvedBy', 'email profile.firstName profile.lastName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ leaveRequests });
  } catch (error) {
    console.error('Get leave requests error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// PUT /api/employees/leave-requests/:requestId/approve
router.put('/leave-requests/:requestId/approve', async (req, res) => {
  try {
    const leaveRequest = await LeaveRequest.findById(req.params.requestId);
    if (!leaveRequest) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({ message: `Cannot approve a request that is already ${leaveRequest.status}` });
    }

    leaveRequest.status = 'approved';
    leaveRequest.approvedBy = req.user.id;
    leaveRequest.approvedAt = new Date();
    await leaveRequest.save();

    await Employee.updateOne(
      { _id: leaveRequest.employee },
      { $inc: { [`leaveBalances.${leaveRequest.type}.usedDays`]: leaveRequest.days } }
    );

    res.json(leaveRequest);
  } catch (error) {
    console.error('Approve leave request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// PUT /api/employees/leave-requests/:requestId/reject
router.put('/leave-requests/:requestId/reject', async (req, res) => {
  try {
    const { rejectionReason } = req.body;

    const leaveRequest = await LeaveRequest.findById(req.params.requestId);
    if (!leaveRequest) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({ message: `Cannot reject a request that is already ${leaveRequest.status}` });
    }

    leaveRequest.status = 'rejected';
    leaveRequest.rejectionReason = rejectionReason || '';
    await leaveRequest.save();

    res.json(leaveRequest);
  } catch (error) {
    console.error('Reject leave request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// DELETE /api/employees/leave-requests/:requestId - cancel a request
router.delete('/leave-requests/:requestId', async (req, res) => {
  try {
    const leaveRequest = await LeaveRequest.findById(req.params.requestId);
    if (!leaveRequest) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    if (leaveRequest.status === 'approved') {
      await Employee.updateOne(
        { _id: leaveRequest.employee },
        { $inc: { [`leaveBalances.${leaveRequest.type}.usedDays`]: -leaveRequest.days } }
      );
    }

    await leaveRequest.deleteOne();

    res.json({ message: 'Leave request cancelled' });
  } catch (error) {
    console.error('Cancel leave request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /api/employees/:id - employee detail
router.get('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id)
      .populate('userId', 'email profile.firstName profile.lastName role')
      .populate('createdBy', 'email profile.firstName profile.lastName');

    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const leaveRequests = await LeaveRequest.find({ employee: employee._id })
      .populate('requestedBy', 'email profile.firstName profile.lastName')
      .populate('approvedBy', 'email profile.firstName profile.lastName')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({ employee, leaveRequests });
  } catch (error) {
    console.error('Get employee error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// PUT /api/employees/:id - update employee profile
router.put('/:id', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, position, department, hireDate,
      userId, status, leaveBalances
    } = req.body;

    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (firstName !== undefined) employee.firstName = firstName;
    if (lastName !== undefined) employee.lastName = lastName;
    if (email !== undefined) employee.email = email;
    if (phone !== undefined) employee.phone = phone;
    if (position !== undefined) employee.position = position;
    if (department !== undefined) employee.department = department;
    if (hireDate !== undefined) employee.hireDate = hireDate;
    if (status !== undefined) employee.status = status;
    if (userId !== undefined) employee.userId = userId || undefined;

    if (leaveBalances) {
      ['vacation', 'publicHoliday', 'sick'].forEach((type) => {
        if (leaveBalances[type]?.allocatedDays !== undefined) {
          employee.leaveBalances[type].allocatedDays = leaveBalances[type].allocatedDays;
        }
      });
    }

    await employee.save();

    res.json(employee);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'This user account is already linked to another employee profile' });
    }
    console.error('Update employee error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /api/employees/:id/leave-requests - leave history for one employee
router.get('/:id/leave-requests', async (req, res) => {
  try {
    const leaveRequests = await LeaveRequest.find({ employee: req.params.id })
      .populate('requestedBy', 'email profile.firstName profile.lastName')
      .populate('approvedBy', 'email profile.firstName profile.lastName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ leaveRequests });
  } catch (error) {
    console.error('Get employee leave requests error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// POST /api/employees/:id/leave-requests - create a leave request
router.post('/:id/leave-requests', async (req, res) => {
  try {
    const { type, startDate, endDate, reason } = req.body;

    if (!type || !startDate || !endDate) {
      return res.status(400).json({ message: 'type, startDate and endDate are required' });
    }
    if (!['vacation', 'publicHoliday', 'sick'].includes(type)) {
      return res.status(400).json({ message: 'Invalid leave type' });
    }

    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const days = countInclusiveDays(startDate, endDate);
    if (days < 1) {
      return res.status(400).json({ message: 'endDate must be on or after startDate' });
    }

    const isSick = type === 'sick';

    const leaveRequest = await LeaveRequest.create({
      employee: employee._id,
      type,
      startDate,
      endDate,
      days,
      reason,
      requestedBy: req.user.id,
      status: isSick ? 'approved' : 'pending',
      approvedBy: isSick ? req.user.id : undefined,
      approvedAt: isSick ? new Date() : undefined
    });

    if (isSick) {
      await Employee.updateOne(
        { _id: employee._id },
        { $inc: { 'leaveBalances.sick.usedDays': days } }
      );
    }

    res.status(201).json(leaveRequest);
  } catch (error) {
    console.error('Create leave request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

export default router;
