import express from 'express';
import Delivery from '../models/Delivery.js';
import Bag from '../models/Bag.js';
import User from '../models/User.js';
import { protect, authorize } from '../middleware/auth.js'; //
import { resolveBusinessDateRange, toBusinessDateKey } from '../utils/businessDate.js';

const router = express.Router();

router.use(protect);

// @desc    Get dashboard statistics
// @route   GET /api/reports/dashboard
// @access  Private
router.get('/dashboard', protect, async (req, res) => {
  try {
    const { dateRange = 'today' } = req.query;
    
    // Calculate date ranges
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    let rangeStart = startOfToday;
    let rangeEnd = startOfTomorrow;
    switch (dateRange) {
      case 'week':
        rangeStart = startOfWeek;
        rangeEnd = endOfWeek;
        break;
      case 'month':
        rangeStart = startOfMonth;
        rangeEnd = startOfNextMonth;
        break;
      case 'today':
      default:
        rangeStart = startOfToday;
        rangeEnd = startOfTomorrow;
        break;
    }

    const dateFilter = {
      scheduledTime: {
        $gte: rangeStart,
        $lt: rangeEnd
      }
    };

    const nonCancelledFilter = {
      status: { $nin: ['cancelled', 'Cancelled', 'CANCELLED'] }
    };

    // Filter to exclude tasks from delivery calculations
    const deliveryOnlyFilter = {
      $or: [
        { type: { $exists: false } },
        { type: { $ne: 'Task' } }
      ]
    };

    const [
      scheduledDeliveriesToday,
      availableBags,
      lateDeliveries,
      activeDrivers,
      monthlyComplaints,
      totalDeliveries,
      successfulDeliveries,
      lateDeliveriesData,
      deliveryTrends,
      driverPerformance,
      completedDeliveriesToday
    ] = await Promise.all([
      // Deliveries scheduled in the selected range (all statuses) - exclude tasks
      Delivery.countDocuments({
        ...dateFilter,
        ...deliveryOnlyFilter
      }),
      
      // Available bags
      Bag.countDocuments({ status: 'available' }),
      
      // Late deliveries (delivered only, non-cancelled) - exclude tasks
      Delivery.countDocuments({
        ...nonCancelledFilter,
        ...dateFilter,
        ...deliveryOnlyFilter,
        status: 'delivered',
        lateMinutes: { $gt: 0 }
      }),
      
      // Active drivers
      User.countDocuments({
        role: 'driver',
        'profile.status': 'available'
      }),
      
      // Monthly complaints - exclude tasks
      Delivery.countDocuments({
        scheduledTime: {
          $gte: startOfMonth,
          $lt: startOfNextMonth
        },
        ...nonCancelledFilter,
        ...deliveryOnlyFilter,
        'complaint.hasComplaint': true
      }),
      
      // Total deliveries (non-cancelled) in the range - exclude tasks
      Delivery.countDocuments({
        ...nonCancelledFilter,
        ...dateFilter,
        ...deliveryOnlyFilter
      }),
      
      // Successful deliveries (delivered on-time, no complaint) - exclude tasks
      Delivery.countDocuments({
        ...nonCancelledFilter,
        ...dateFilter,
        ...deliveryOnlyFilter,
        status: 'delivered',
        lateMinutes: 0,
        'complaint.hasComplaint': { $ne: true }
      }),
      
      // Late deliveries data for averages - exclude tasks, only delivered
      Delivery.find({
        ...nonCancelledFilter,
        ...dateFilter,
        ...deliveryOnlyFilter,
        status: 'delivered',
        lateMinutes: { $gt: 0 }
      }).select('lateMinutes'),
      
      // Delivery trends - exclude tasks
      Delivery.aggregate([
        { $match: { ...dateFilter, ...nonCancelledFilter, ...deliveryOnlyFilter } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: '$scheduledTime'
              }
            },
            total: { $sum: 1 },
            onTime: {
              $sum: {
                $cond: [
                  { $and: [
                    { $eq: ["$status", "delivered"] },
                    { $eq: ["$lateMinutes", 0] }
                  ]},
                  1,
                  0
                ]
              }
            },
            late: {
              $sum: {
                $cond: [{ $gt: ["$lateMinutes", 0] }, 1, 0]
              }
            }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      
      // Driver performance
      User.aggregate([
        { $match: { role: 'driver' } },
        {
          $lookup: {
            from: 'deliveries',
            let: { driverId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$driver', '$$driverId'] },
                      { $gte: ['$scheduledTime', rangeStart] },
                      { $lt: ['$scheduledTime', rangeEnd] }
                    ]
                  },
                  status: { $nin: ['cancelled', 'Cancelled', 'CANCELLED'] },
                  $or: [
                    { type: { $exists: false } },
                    { type: { $ne: 'Task' } }
                  ]
                }
              }
            ],
            as: 'deliveries'
          }
        },
        {
          $project: {
            _id: 1,
            firstName: { $ifNull: ['$profile.firstName', ''] },
            lastName: { $ifNull: ['$profile.lastName', ''] },
            status: '$profile.status',
            fullName: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ['$profile.firstName', ''] },
                    ' ',
                    { $ifNull: ['$profile.lastName', ''] }
                  ]
                }
              }
            },
            deliveriesCount: { $size: '$deliveries' },
            lateCount: {
              $size: {
                $filter: {
                  input: '$deliveries',
                  as: 'delivery',
                  cond: { $gt: ['$$delivery.lateMinutes', 0] }
                }
              }
            }
          }
        }
      ]),
      
      // Completed deliveries today (all delivered regardless of lateness) - exclude tasks
      Delivery.countDocuments({
        ...nonCancelledFilter,
        ...dateFilter,
        ...deliveryOnlyFilter,
        status: 'delivered'
      })
    ]);

    const todayDeliveries = scheduledDeliveriesToday;

    // Calculate derived statistics
    const avgDeliveriesPerAgent = activeDrivers ? Math.round(todayDeliveries / activeDrivers) : 0;
    const accuracyRate = totalDeliveries ? Math.round((successfulDeliveries / totalDeliveries) * 100) : 0;
    const avgLateTime = lateDeliveriesData.length 
      ? Math.round(lateDeliveriesData.reduce((acc, del) => acc + (del.lateMinutes || 0), 0) / lateDeliveriesData.length)
      : 0;

    res.json({
      success: true,
      data: {
        todayDeliveries,
        totalDeliveries,
        completedDeliveriesToday,
        availableBags,
        lateDeliveries,
        activeDrivers,
        avgDeliveriesPerAgent,
        monthlyComplaints,
        accuracyRate,
        avgLateTime,
        deliveryTrends,
        driverPerformance
      }
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Get report data
// @route   GET /api/reports
// @access  Private
router.get('/', protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }

    // startDate/endDate as "YYYY-MM-DD" are Dubai business dates (whole end
    // day included); full ISO timestamps are exact instants. Never uses the
    // server's OS timezone — see utils/businessDate.js.
    const range = resolveBusinessDateRange(startDate, endDate);
    if (!range) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date range. Use YYYY-MM-DD (business dates) or ISO timestamps, with endDate on/after startDate.'
      });
    }
    const { start, endExclusive } = range;

    // Get deliveries in date range
    const deliveries = await Delivery.find({
      scheduledTime: {
        $gte: start,
        $lt: endExclusive
      }
    }).populate('driver', 'profile');

    // Calculate metrics
    const totalDeliveries = deliveries.length;
    let deliveredCount = 0;
    let lateDeliveries = 0;
    let earlyDeliveries = 0;
    let complaintsCount = 0;

    const computeTiming = (delivery) => {
      if (!delivery?.scheduledTime) {
        return { lateMinutes: 0, earlyMinutes: 0 };
      }

      const scheduledTime = new Date(delivery.scheduledTime);
      const deliveredTime = delivery.deliveredTime ? new Date(delivery.deliveredTime) : null;
      const earlyThreshold = new Date(scheduledTime.getTime() - (180 * 60 * 1000));

      let lateMinutes = delivery.lateMinutes ?? 0;
      let earlyMinutes = delivery.earlyMinutes ?? 0;

      if (deliveredTime && !Number.isNaN(deliveredTime.getTime())) {
        const diffMinutes = Math.round((deliveredTime - scheduledTime) / (1000 * 60));
        const computedEarlyMinutes = deliveredTime < earlyThreshold
          ? Math.max(0, Math.round((earlyThreshold - deliveredTime) / (1000 * 60)))
          : 0;
        const computedLateMinutes = diffMinutes > 0 ? diffMinutes : 0;

        earlyMinutes = computedEarlyMinutes;
        lateMinutes = computedLateMinutes;
      } else {
        earlyMinutes = 0;
        lateMinutes = 0;
      }

      return { lateMinutes, earlyMinutes };
    };

    const deliveriesPerDay = {};
    deliveries.forEach(delivery => {
      const date = toBusinessDateKey(delivery.scheduledTime);
      deliveriesPerDay[date] = (deliveriesPerDay[date] || 0) + 1;

      if (delivery.status === 'delivered') {
        deliveredCount += 1;
      }

      if (delivery.complaint?.hasComplaint) {
        complaintsCount += 1;
      }

      const { lateMinutes, earlyMinutes } = computeTiming(delivery);
      if (lateMinutes > 0) {
        lateDeliveries += 1;
      }
      if (earlyMinutes > 0) {
        earlyDeliveries += 1;
      }
    });

    // Deliveries by driver
    const deliveriesByDriver = {};
    deliveries.forEach(delivery => {
      if (delivery.driver) {
        const driverName = `${delivery.driver.profile.firstName} ${delivery.driver.profile.lastName}`;
        deliveriesByDriver[driverName] = (deliveriesByDriver[driverName] || 0) + 1;
      }
    });

    // Deliveries by company
    const deliveriesByCompany = {};
    deliveries.forEach(delivery => {
      deliveriesByCompany[delivery.company] = (deliveriesByCompany[delivery.company] || 0) + 1;
    });

    // Late and early delivery details
    const lateDeliveryDetails = [];
    const earlyDeliveryDetails = [];
    deliveries.forEach(delivery => {
      const { lateMinutes, earlyMinutes } = computeTiming(delivery);
      
      if (lateMinutes > 0) {
        lateDeliveryDetails.push({
          customerName: delivery.customerName,
          customerId: delivery.customerId || delivery._id,
          address: delivery.address,
          lateMinutes: lateMinutes,
          scheduledTime: delivery.scheduledTime,
          deliveredTime: delivery.deliveredTime,
          status: delivery.status
        });
      }
      
      if (earlyMinutes > 0) {
        earlyDeliveryDetails.push({
          customerName: delivery.customerName,
          customerId: delivery.customerId || delivery._id,
          address: delivery.address,
          earlyMinutes: earlyMinutes,
          scheduledTime: delivery.scheduledTime,
          deliveredTime: delivery.deliveredTime,
          status: delivery.status
        });
      }
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalDeliveries,
          deliveredCount,
          lateDeliveries,
          earlyDeliveries,
          complaintsCount,
          accuracyRate: totalDeliveries > 0 ? Math.round((deliveredCount / totalDeliveries) * 100) : 0,
          lateRate: totalDeliveries > 0 ? Math.round((lateDeliveries / totalDeliveries) * 100) : 0,
          earlyRate: totalDeliveries > 0 ? Math.round((earlyDeliveries / totalDeliveries) * 100) : 0
        },
        deliveriesPerDay: Object.entries(deliveriesPerDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, count]) => ({ date, count })),
        deliveriesByDriver: Object.entries(deliveriesByDriver).map(([driver, count]) => ({ driver, count })),
        deliveriesByCompany: Object.entries(deliveriesByCompany).map(([company, count]) => ({ company, count })),
        lateDeliveryDetails: lateDeliveryDetails.sort((a, b) => b.lateMinutes - a.lateMinutes),
        earlyDeliveryDetails: earlyDeliveryDetails.sort((a, b) => b.earlyMinutes - a.earlyMinutes),
        dateRange: {
          startDate: start,
          endDateExclusive: endExclusive
        },
        // Add all deliveries for detailed view
        allDeliveries: deliveries.map(delivery => ({
          ...delivery.toObject(),
          driverName: delivery.driver ? `${delivery.driver.profile?.firstName || ''} ${delivery.driver.profile?.lastName || ''}`.trim() : 'Unassigned',
          lateMinutes: computeTiming(delivery).lateMinutes,
          earlyMinutes: computeTiming(delivery).earlyMinutes
        })),
        // Add unique drivers list
        drivers: [...new Set(deliveries
          .filter(d => d.driver)
          .map(d => `${d.driver.profile?.firstName || ''} ${d.driver.profile?.lastName || ''}`.trim()))].sort(),
        // Add unique areas list
        areas: [...new Set(deliveries
          .map(d => d.area || d.assignedTo?.area || 'Unknown')
          .filter(a => a && a !== 'Unknown'))].sort()
      }
    });
  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @desc    Export reports
// @route   GET /api/reports/export/:format
// @access  Private
router.get('/export/:format', protect, async (req, res) => {
  try {
    const { format } = req.params;
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=delivery-report.csv');
      // TODO: Implement CSV generation
      return res.status(501).json({ 
        success: false,
        message: 'CSV export not implemented yet' 
      });
    } else if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=delivery-report.pdf');
      // TODO: Implement PDF generation
      return res.status(501).json({ 
        success: false,
        message: 'PDF export not implemented yet' 
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'Unsupported export format'
      });
    }
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({
      success: false,
      message: 'Export failed',
      error: error.message
    });
  }
});

export default router;
