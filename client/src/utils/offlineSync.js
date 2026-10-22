/**
 * Offline Sync Manager
 * Handles syncing photos and delivery updates when connection is restored
 */

import { uploadPhoto } from './fileUpload';
import api from '../utils/api';
import {
  getPendingPhotos,
  getPendingSyncQueue,
  markPhotoSynced,
  markQueueItemSynced,
  cleanupOldPhotos,
  cleanupOldQueueItems,
  updateQueueItemSyncStatus,
  getQueueItemsByStatus
} from './offlineStorage';

let isSyncing = false;
let syncCallbacks = [];
let autoSyncTimer = null;
let autoRetryTimer = null;
const MAX_RETRIES = 10;
const RETRY_DELAYS = [1000, 5000, 30000, 5 * 60000, 10 * 60000]; // exponential backoff: 1s, 5s, 30s, 5m, 10m

/**
 * Register callback for sync status updates
 * @param {function} callback - Called with sync status
 */
export const onSyncStatusChange = (callback) => {
  syncCallbacks.push(callback);
  return () => {
    syncCallbacks = syncCallbacks.filter(cb => cb !== callback);
  };
};

/**
 * Notify all listeners of sync status
 */
const notifyListeners = (status) => {
  syncCallbacks.forEach(callback => {
    try {
      callback(status);
    } catch (error) {
      console.error('Sync callback error:', error);
    }
  });
};

/**
 * Upload a single photo
 * @param {object} photo - Photo object from IndexedDB
 * @returns {Promise<string>} Uploaded photo URL
 */
const uploadSinglePhoto = async (photo) => {
  try {
    console.log('📤 Uploading photo for delivery:', photo.deliveryId);
    const photoUrl = await uploadPhoto(photo.photoDataUrl);
    console.log('✅ Photo uploaded successfully:', photoUrl);
    return photoUrl;
  } catch (error) {
    console.error('❌ Failed to upload photo:', error);
    throw error;
  }
};

/**
 * Process a single delivery update
 * @param {object} queueItem - Queue item from IndexedDB
 * @param {string} photoUrl - Uploaded photo URL (if applicable)
 */
const processDeliveryUpdate = async (queueItem, photoUrl = null) => {
  try {
    console.log('📤 Processing delivery update:', queueItem.deliveryId);

    if(queueItem.kind==='bag_collection'){
      await updateQueueItemSyncStatus(queueItem.id,'syncing');
      for(const bagId of queueItem.bagIds||[]){
        await api.post('/bag-operations/movements',{bagId,action:'collect',eventId:queueItem.eventId+':'+bagId,occurredAt:queueItem.timestamp,note:'Physical customer pickup; pending warehouse receipt.'});
      }
      await updateQueueItemSyncStatus(queueItem.id,'synced');
      return;
    }
    // Mark as syncing
    await updateQueueItemSyncStatus(queueItem.id, 'syncing');

    const updateData = {
      deliveryId: queueItem.deliveryId,
      status: queueItem.status,
      proof: queueItem.proof
    };

    // Get bag IDs - support both old bagId and new bagIds format
    const bagIds = queueItem.bagIds || (queueItem.bagId ? [queueItem.bagId] : []);

    // Replace local photo URL with uploaded URL
    if (photoUrl && updateData.proof) {
      updateData.proof.images = [photoUrl];
      updateData.proof.photoUrl = photoUrl;
    }

    // Update delivery status via API
    console.log('📤 Sending delivery update to server:', {
      deliveryId: queueItem.deliveryId,
      status: updateData.status,
      hasProof: !!updateData.proof,
      photoUrl: updateData.proof?.photoUrl
    });
    
    const deliveryResponse = await api.patch(`/deliveries/${queueItem.deliveryId}/status`, {
      status: updateData.status,
      proof: updateData.proof,
      // Provide a primary bag for association on the delivery record
      bagIds,
      bagId: queueItem.proof?.type === 'bag_collection' ? undefined : bagIds[0]
    });

    console.log('✅ Delivery update response:', {
      success: deliveryResponse.data?.success,
      deliveryId: deliveryResponse.data?.delivery?._id,
      status: deliveryResponse.data?.delivery?.status
    });

    // Mark as synced
    await updateQueueItemSyncStatus(queueItem.id, 'synced');
    console.log('✅ Delivery update processed successfully');
  } catch (error) {
    console.error('❌ Failed to process delivery update:', {
      deliveryId: queueItem.deliveryId,
      error: error.response?.data || error.message,
      fullError: error
    });
    // Mark as failed with error message
    await updateQueueItemSyncStatus(queueItem.id, 'failed', error.message);
    throw error;
  }
};

/**
 * Sync all pending photos and deliveries
 * @returns {Promise<{success: number, failed: number}>}
 */
export const syncOfflineData = async () => {
  if (isSyncing) {
    console.log('⏳ Sync already in progress');
    return { success: 0, failed: 0 };
  }

  if (!navigator.onLine) {
    console.log('🔴 Cannot sync - offline');
    return { success: 0, failed: 0 };
  }

  isSyncing = true;
  let successCount = 0;
  let failedCount = 0;

  try {
    notifyListeners({ syncing: true, progress: 0 });

    // Get all pending items
    const [pendingPhotos, pendingQueue] = await Promise.all([
      getPendingPhotos(),
      getPendingSyncQueue()
    ]);

    const totalItems = pendingPhotos.length + pendingQueue.length;
    
    if (totalItems === 0) {
      console.log('✅ No pending items to sync');
      notifyListeners({ syncing: false, progress: 100 });
      return { success: 0, failed: 0 };
    }

    console.log(`🔄 Starting sync: ${pendingPhotos.length} photos, ${pendingQueue.length} deliveries`);

    // Create a map to link photos with their delivery updates
    const photoMap = new Map();
    pendingPhotos.forEach(photo => {
      if (!photoMap.has(photo.deliveryId)) {
        photoMap.set(photo.deliveryId, []);
      }
      photoMap.get(photo.deliveryId).push(photo);
    });

    let processedItems = 0;

    // Process each delivery update with its photos
    for (const queueItem of pendingQueue) {
      try {
        const deliveryPhotos = photoMap.get(queueItem.deliveryId) || [];
        let uploadedPhotoUrl = null;
        let uploadedPhotoId = null;

        // Upload the first photo for this delivery
        if (deliveryPhotos.length > 0) {
          const photo = deliveryPhotos[0];
          try {
            uploadedPhotoUrl = await uploadSinglePhoto(photo);
            uploadedPhotoId = photo.id;
            successCount++;
          } catch (error) {
            console.error('Photo upload failed:', error);
            failedCount++;
            // Keep the movement and proof pending together when evidence fails.
            throw error;
          }
        }

        // Process the delivery update
        await processDeliveryUpdate(queueItem, uploadedPhotoUrl);
        if (uploadedPhotoId != null) await markPhotoSynced(uploadedPhotoId);
        await markQueueItemSynced(queueItem.id);
        successCount++;

        processedItems++;
        const progress = Math.round((processedItems / totalItems) * 100);
        notifyListeners({ syncing: true, progress, successCount, failedCount });

      } catch (error) {
        console.error('Failed to process queue item:', error);
        failedCount++;
      }
    }

    // Upload any remaining orphaned photos (photos without a matching queue item)
    const processedDeliveryIds = new Set(pendingQueue.map(q => q.deliveryId));
    const orphanedPhotos = pendingPhotos.filter(p => !processedDeliveryIds.has(p.deliveryId));

    for (const photo of orphanedPhotos) {
      try {
        await uploadSinglePhoto(photo);
        await markPhotoSynced(photo.id);
        successCount++;
        
        processedItems++;
        const progress = Math.round((processedItems / totalItems) * 100);
        notifyListeners({ syncing: true, progress, successCount, failedCount });
      } catch (error) {
        console.error('Orphaned photo upload failed:', error);
        failedCount++;
      }
    }

    // Cleanup old synced items
    await Promise.all([
      cleanupOldPhotos(),
      cleanupOldQueueItems()
    ]);

    console.log(`✅ Sync complete: ${successCount} succeeded, ${failedCount} failed`);
    notifyListeners({ 
      syncing: false, 
      progress: 100, 
      successCount, 
      failedCount,
      completed: true 
    });

    return { success: successCount, failed: failedCount };

  } catch (error) {
    console.error('❌ Sync failed:', error);
    notifyListeners({ syncing: false, error: error.message });
    return { success: successCount, failed: failedCount };
  } finally {
    isSyncing = false;
  }
};

/**
 * Auto-retry failed items with exponential backoff
 */
export const setupAutoRetry = () => {
  const retryLoop = async () => {
    if (isSyncing || !navigator.onLine) return;

    try {
      const failedItems = await getQueueItemsByStatus('failed');
      if (failedItems.length === 0) return;

      console.log(`⏱️ Auto-retry: Found ${failedItems.length} failed items`);

      for (const item of failedItems) {
        // Check if max retries exceeded
        if ((item.retries || 0) >= MAX_RETRIES) {
          console.log(`⚠️ Auto-retry: Skipping ${item.deliveryId} - max retries (${MAX_RETRIES}) exceeded`);
          continue;
        }

        // Calculate delay based on retry count
        const delayIndex = Math.min(item.retries || 0, RETRY_DELAYS.length - 1);
        const nextRetryTime = (item.lastSyncAttempt || 0) + RETRY_DELAYS[delayIndex];
        const timeSinceLastAttempt = Date.now() - (item.lastSyncAttempt || 0);

        if (timeSinceLastAttempt < RETRY_DELAYS[delayIndex]) {
          const waitTime = RETRY_DELAYS[delayIndex] - timeSinceLastAttempt;
          console.log(`⏱️ Auto-retry: Waiting ${Math.round(waitTime / 1000)}s before retry on ${item.deliveryId}`);
          continue;
        }

        // Reset status to pending and trigger sync
        console.log(`🔄 Auto-retry: Retrying ${item.deliveryId} (attempt ${(item.retries || 0) + 1})`);
        await updateQueueItemSyncStatus(item.id, 'pending', null);
      }

      // Trigger sync for any pending items
      const pending = await getQueueItemsByStatus('pending');
      if (pending.length > 0) {
        console.log(`🔄 Auto-retry: Starting sync for ${pending.length} pending items`);
        await syncOfflineData();
      }
    } catch (error) {
      console.error('Auto-retry loop error:', error);
    }
  };

  // Start retry loop every 10 seconds
  if (!autoRetryTimer) {
    autoRetryTimer = setInterval(retryLoop, 10000);
    console.log('✅ Auto-retry configured (10s check interval)');
  }
};

/**
 * Stop auto-retry
 */
export const stopAutoRetry = () => {
  if (autoRetryTimer) {
    clearInterval(autoRetryTimer);
    autoRetryTimer = null;
    console.log('⏹️ Auto-retry stopped');
  }
};

/**
 * Auto-sync when connection is restored
 */
export const setupAutoSync = () => {
  window.addEventListener('online', async () => {
    console.log('🟢 Connection restored - starting auto-sync');
    
    // Wait a bit to ensure connection is stable
    setTimeout(async () => {
      const result = await syncOfflineData();
      console.log('Auto-sync result:', result);
    }, 2000);
  });

  // Start periodic auto-sync loop
  if (!autoSyncTimer) {
    autoSyncTimer = setInterval(async () => {
      try {
        if (!isSyncing && navigator.onLine) {
          const pending = await hasPendingSync();
          if (pending) {
            console.log('⏱️ Auto-sync loop: pending items found, syncing...');
            await syncOfflineData();
          }
        }
      } catch (e) {
        console.warn('Auto-sync loop error:', e?.message || e);
      }
    }, 30000); // every 30s while online
    console.log('✅ Auto-sync configured (with periodic check)');
  } else {
    console.log('ℹ️ Auto-sync already configured');
  }

  // Note: no cleanup here; app lifecycle manages timers
};

/**
 * Check if there are pending items to sync
 * @returns {Promise<boolean>}
 */
export const hasPendingSync = async () => {
  try {
    const [photos, queue] = await Promise.all([
      getPendingPhotos(),
      getPendingSyncQueue()
    ]);
    return photos.length > 0 || queue.length > 0;
  } catch (error) {
    console.error('Failed to check pending sync:', error);
    return false;
  }
};
