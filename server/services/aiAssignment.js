import { saveReportingDelivery } from './reportingOutbox.js';
import axios from 'axios';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';

/**
 * AI-powered delivery assignment service
 * Uses OpenAI or rule-based scoring to assign deliveries to optimal drivers
 */

// Calculate distance between two coordinates (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
  
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Get driver's current location (from last delivery or profile)
const getDriverLocation = async (driverId) => {
  try {
    // Get driver's most recent completed delivery location
    const lastDelivery = await Delivery.findOne({
      driver: driverId,
      status: 'delivered'
    })
      .sort({ updatedAt: -1 })
      .select('gpsLocation')
      .lean();

    if (lastDelivery?.gpsLocation?.lat && lastDelivery?.gpsLocation?.lng) {
      return {
        lat: lastDelivery.gpsLocation.lat,
        lng: lastDelivery.gpsLocation.lng
      };
    }

    // Fallback to driver's home base or default location
    const driver = await User.findById(driverId).select('profile').lean();
    return driver?.profile?.location || null;
  } catch (error) {
    console.error('Error getting driver location:', error);
    return null;
  }
};

// Get driver's current workload
const getDriverWorkload = async (driverId, date) => {
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const deliveries = await Delivery.find({
      driver: driverId,
      scheduledTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ['pending', 'assigned', 'in_progress', 'delivered'] }
    }).lean();

    return {
      total: deliveries.length,
      pending: deliveries.filter(d => d.status === 'pending' || d.status === 'assigned').length,
      inProgress: deliveries.filter(d => d.status === 'in_progress').length,
      delivered: deliveries.filter(d => d.status === 'delivered').length
    };
  } catch (error) {
    console.error('Error getting driver workload:', error);
    return { total: 0, pending: 0, inProgress: 0, delivered: 0 };
  }
};

// Get driver's historical performance
const getDriverPerformance = async (driverId) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const deliveries = await Delivery.find({
      driver: driverId,
      updatedAt: { $gte: thirtyDaysAgo }
    })
      .select('status lateMinutes earlyMinutes')
      .lean();

    const total = deliveries.length;
    const completed = deliveries.filter(d => d.status === 'delivered').length;
    const onTime = deliveries.filter(d => 
      d.status === 'delivered' && !d.lateMinutes && !d.earlyMinutes
    ).length;
    const late = deliveries.filter(d => d.lateMinutes > 0).length;

    return {
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      onTimeRate: completed > 0 ? (onTime / completed) * 100 : 0,
      lateRate: completed > 0 ? (late / completed) * 100 : 0,
      totalDeliveries: total
    };
  } catch (error) {
    console.error('Error getting driver performance:', error);
    return { completionRate: 0, onTimeRate: 0, lateRate: 0, totalDeliveries: 0 };
  }
};

// Calculate driver score for a delivery
const calculateDriverScore = (driver, delivery, options = {}) => {
  let score = 0; // Start with 0, build up based on matches

  // CRITICAL: Check 35 delivery limit
  if (driver.workload.total >= 35) {
    return 0; // Driver has reached daily limit
  }

  // PRIORITY 1: Zone/Area Match (MOST IMPORTANT - 50 points)
  if (driver.areas && delivery.area && driver.areas.includes(delivery.area)) {
    score += 50; // Zone match is top priority
  } else if (delivery.area) {
    score -= 30; // Heavy penalty for wrong zone
  }

  // PRIORITY 2: Workload Balance (30 points max)
  // Favor drivers with fewer deliveries
  const workloadScore = Math.max(0, 30 - (driver.workload.total * 1.5));
  score += workloadScore;

  // PRIORITY 3: Distance within zone (20 points)
  if (driver.distance !== null && driver.distance !== Infinity) {
    const distanceScore = Math.max(0, 20 - driver.distance); // Closer is better
    score += distanceScore;
  } else {
    score += 10; // Neutral for unknown location
  }

  // Factor 4: Performance bonus (0 to +15 points)
  const performanceBonus = (driver.performance.onTimeRate / 100) * 15;
  score += performanceBonus;

  // Factor 5: Company preference (+10 points)
  if (driver.preferredCompanies && delivery.company && 
      driver.preferredCompanies.includes(delivery.company)) {
    score += 10;
  }

  // Factor 6: Timing consideration - penalize if driver has conflicting time slots
  if (driver.workload.inProgress > 0) {
    score -= 10; // Currently busy with other deliveries
  }

  return Math.max(0, Math.min(100, score));
};

// Use OpenAI for intelligent assignment (optional)
const useOpenAIAssignment = async (drivers, delivery) => {
  if (!process.env.OPENAI_API_KEY) {
    return null; // Fall back to rule-based scoring
  }

  try {
    const prompt = `You are an AI assistant for a delivery management system. Analyze the following data and recommend the best driver for this delivery.

Delivery Details:
- Location: ${delivery.address}
- Area: ${delivery.area || 'Unknown'}
- Company: ${delivery.company || 'Unknown'}
- Customer: ${delivery.customerName}
- Scheduled Time: ${delivery.scheduledTime}

Available Drivers:
${drivers.map((d, i) => `
Driver ${i + 1}:
- Name: ${d.name}
- Distance: ${d.distance === Infinity ? 'Unknown' : d.distance.toFixed(2) + ' km'}
- Current Workload: ${d.workload.pending} pending, ${d.workload.inProgress} in progress
- Performance: ${d.performance.onTimeRate.toFixed(1)}% on-time rate
- Areas: ${d.areas?.join(', ') || 'Any'}
- Score: ${d.score.toFixed(1)}
`).join('\n')}

Based on distance, workload, performance, and area knowledge, which driver should be assigned? Respond with ONLY the driver number (1, 2, 3, etc.) and a brief one-sentence reason.`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an expert logistics AI that assigns deliveries to drivers optimally.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 100
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const aiResponse = response.data.choices[0].message.content.trim();
    console.log('OpenAI recommendation:', aiResponse);

    // Parse driver number from response
    const match = aiResponse.match(/(\d+)/);
    if (match) {
      const driverIndex = parseInt(match[1]) - 1;
      if (driverIndex >= 0 && driverIndex < drivers.length) {
        return {
          driver: drivers[driverIndex],
          reason: aiResponse,
          method: 'openai'
        };
      }
    }

    return null;
  } catch (error) {
    console.error('OpenAI assignment error:', error.message);
    return null;
  }
};

/**
 * Main function: Auto-assign a delivery to the best available driver
 * @param {Object} delivery - The delivery to assign
 * @param {Object} options - Assignment options (useAI, maxDistance, etc.)
 * @returns {Object} - Assigned driver and assignment details
 */
export const autoAssignDelivery = async (delivery, options = {}) => {
  try {
    const {
      useAI = false,
      maxDistance = 50, // km
      minScore = 20, // Adjusted for new zone-based scoring
      excludeDrivers = [],
      maxDeliveriesPerDriver = 35 // Daily limit per driver
    } = options;

    console.log(`🤖 Auto-assigning delivery ${delivery._id}...`);

    // Get all available drivers
    const drivers = await User.find({
      role: 'driver',
      _id: { $nin: excludeDrivers },
      'profile.isActive': { $ne: false }
    })
      .select('profile email')
      .lean();

    if (drivers.length === 0) {
      throw new Error('No available drivers found');
    }

    console.log(`Found ${drivers.length} available drivers`);

    // Enrich driver data
    const enrichedDrivers = await Promise.all(
      drivers.map(async (driver) => {
        const location = await getDriverLocation(driver._id);
        const workload = await getDriverWorkload(driver._id, delivery.scheduledTime);
        const performance = await getDriverPerformance(driver._id);

        const distance = delivery.gpsLocation?.lat && delivery.gpsLocation?.lng && location
          ? calculateDistance(
              location.lat,
              location.lng,
              delivery.gpsLocation.lat,
              delivery.gpsLocation.lng
            )
          : Infinity;

        return {
          id: driver._id,
          name: `${driver.profile?.firstName || ''} ${driver.profile?.lastName || ''}`.trim() || driver.email,
          email: driver.email,
          location,
          distance,
          workload,
          performance,
          areas: driver.profile?.areas || [],
          preferredCompanies: driver.profile?.preferredCompanies || [],
          isAvailable: distance === Infinity ? true : distance <= maxDistance
        };
      })
    );

    // Calculate scores for each driver
    const scoredDrivers = enrichedDrivers.map(driver => ({
      ...driver,
      score: calculateDriverScore(driver, delivery, options)
    }));

    // Filter and sort by score
    const eligibleDrivers = scoredDrivers
      .filter(d => d.score >= minScore)
      .sort((a, b) => b.score - a.score);

    if (eligibleDrivers.length === 0) {
      throw new Error('No eligible drivers found within criteria');
    }

    console.log(`${eligibleDrivers.length} eligible drivers found`);
    console.log('Delivery Zone:', delivery.area || 'Not specified');
    console.log('Top 3 candidates:', eligibleDrivers.slice(0, 3).map(d => ({
      name: d.name,
      score: d.score.toFixed(1),
      zone: d.areas.join(', ') || 'No zones',
      zoneMatch: d.areas.includes(delivery.area) ? '✓' : '✗',
      workload: `${d.workload.total}/35`,
      distance: d.distance === Infinity ? 'Unknown' : d.distance.toFixed(2) + ' km'
    })));

    // Try OpenAI assignment if enabled
    let assignmentResult = null;
    if (useAI) {
      assignmentResult = await useOpenAIAssignment(eligibleDrivers.slice(0, 5), delivery);
    }

    // Fall back to rule-based scoring if AI not used or failed
    if (!assignmentResult) {
      assignmentResult = {
        driver: eligibleDrivers[0],
        reason: `Best match based on score: ${eligibleDrivers[0].score.toFixed(1)}/100`,
        method: 'rule-based'
      };
    }

    console.log(`✅ Assigned to ${assignmentResult.driver.name} (${assignmentResult.method})`);

    return {
      success: true,
      assignedDriver: {
        id: assignmentResult.driver.id,
        name: assignmentResult.driver.name,
        email: assignmentResult.driver.email
      },
      score: assignmentResult.driver.score,
      distance: assignmentResult.driver.distance,
      reason: assignmentResult.reason,
      method: assignmentResult.method,
      alternativeDrivers: eligibleDrivers.slice(1, 4).map(d => ({
        id: d.id,
        name: d.name,
        score: d.score,
        distance: d.distance
      }))
    };
  } catch (error) {
    console.error('Auto-assignment error:', error);
    throw error;
  }
};

/**
 * Batch auto-assign multiple deliveries
 * Respects zone priority, 35 delivery limit per driver, and timing
 */
export const batchAutoAssign = async (deliveries, options = {}) => {
  const results = {
    success: [],
    failed: []
  };

  console.log(`📦 Batch assigning ${deliveries.length} deliveries...`);

  for (const delivery of deliveries) {
    try {
      const assignment = await autoAssignDelivery(delivery, options);
      
      // Update delivery with assigned driver
      delivery.driver = assignment.assignedDriver.id;
      delivery.status = 'assigned';
      await saveReportingDelivery(delivery);

      results.success.push({
        deliveryId: delivery._id,
        assignment
      });
    } catch (error) {
      results.failed.push({
        deliveryId: delivery._id,
        error: error.message
      });
    }
  }

  return results;
};

export default {
  autoAssignDelivery,
  batchAutoAssign
};
