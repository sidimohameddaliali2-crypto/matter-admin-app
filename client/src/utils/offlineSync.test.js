import api from './api';
import {syncOfflineData, hasPendingSync, syncAttemptTime, retryDeliverySync} from './offlineSync';
import {uploadPhoto} from './fileUpload';
import * as storage from './offlineStorage';
jest.mock('./api',()=>({__esModule:true,default:{post:jest.fn(),patch:jest.fn()}}));
jest.mock('./fileUpload',()=>({uploadPhoto:jest.fn()}));
jest.mock('./offlineStorage',()=>({getPendingPhotos:jest.fn(),getPendingSyncQueue:jest.fn(),markPhotoSynced:jest.fn(),markQueueItemSynced:jest.fn(),cleanupOldPhotos:jest.fn(),cleanupOldQueueItems:jest.fn(),updateQueueItemSyncStatus:jest.fn(),getQueueItemsByStatus:jest.fn()}));
beforeEach(()=>{Object.values(storage).filter(jest.isMockFunction).forEach(fn=>fn.mockReset());api.post.mockReset();api.patch.mockReset();uploadPhoto.mockReset();storage.getPendingPhotos.mockResolvedValue([]);storage.getPendingSyncQueue.mockResolvedValue([]);storage.getQueueItemsByStatus.mockResolvedValue([]);Object.defineProperty(navigator,'onLine',{configurable:true,value:true});jest.spyOn(console,'log').mockImplementation(()=>{});jest.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>jest.restoreAllMocks());
test('offline collection keeps its typed proof and sends no reassignment or warehouse return',async()=>{
  storage.getPendingSyncQueue.mockResolvedValue([{id:1,deliveryId:'d1',status:'completed',bagIds:['BAG-0001'],proof:{type:'bag_collection',scannedBags:['BAG-0001']}}]);
  api.patch.mockResolvedValue({data:{success:true,delivery:{_id:'d1',status:'completed'}}});await syncOfflineData();
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(api.patch).toHaveBeenCalledWith('/deliveries/d1/status',expect.objectContaining({bagIds:['BAG-0001'],bagId:undefined,proof:expect.objectContaining({type:'bag_collection'})}));
  expect(storage.markQueueItemSynced).toHaveBeenCalledWith(1);
});
test('failed bag movements are left failed and not marked synced',async()=>{
  storage.getPendingSyncQueue.mockResolvedValue([{id:2,kind:'bag_collection',eventId:'stable',bagIds:['BAG-0001','BAG-0002']}]);
  api.post.mockResolvedValueOnce({data:{success:true}}).mockRejectedValueOnce(new Error('Custody conflict'));
  await syncOfflineData();
  expect(storage.updateQueueItemSyncStatus).toHaveBeenCalledWith(2,'failed','Custody conflict');
  expect(storage.markQueueItemSynced).not.toHaveBeenCalled();
  expect(api.post.mock.calls[0][1].eventId).toBe('stable:BAG-0001');
});
test('proof upload failure cannot mark delivery or photo synchronized',async()=>{
  storage.getPendingSyncQueue.mockResolvedValue([{id:3,deliveryId:'d3',status:'delivered',proof:{}}]);
  storage.getPendingPhotos.mockResolvedValue([{id:9,deliveryId:'d3',photoDataUrl:'photo'}]);
  uploadPhoto.mockRejectedValue(new Error('Upload unavailable'));await syncOfflineData();
  expect(api.patch).not.toHaveBeenCalled();expect(storage.markPhotoSynced).not.toHaveBeenCalled();expect(storage.markQueueItemSynced).not.toHaveBeenCalled();
});
test('offline delivery keeps shutter time when photo uploads hours later',async()=>{
  const capturedAt='2026-10-22T04:05:00.000Z';
  storage.getPendingSyncQueue.mockResolvedValue([{id:4,deliveryId:'d4',status:'delivered',
    proof:{photoCapturedAt:capturedAt,photoSource:'camera',timestamp:'2026-10-22T04:06:00.000Z'}}]);
  storage.getPendingPhotos.mockResolvedValue([{id:10,deliveryId:'d4',photoDataUrl:'offline-photo'}]);
  uploadPhoto.mockResolvedValue('/uploaded-photo.jpg');
  api.patch.mockResolvedValue({data:{success:true,delivery:{_id:'d4',status:'delivered'}}});
  await syncOfflineData();
  expect(api.patch).toHaveBeenCalledWith('/deliveries/d4/status',expect.objectContaining({proof:expect.objectContaining({
    photoCapturedAt:capturedAt,photoSource:'camera',photoUrl:'/uploaded-photo.jpg'
  })}));
  expect(storage.markPhotoSynced).toHaveBeenCalledWith(10);
  expect(storage.markQueueItemSynced).toHaveBeenCalledWith(4);
});
test('a success envelope with an unchanged status never discards the photo or queued update',async()=>{
 storage.getPendingSyncQueue.mockResolvedValue([{id:5,deliveryId:'d5',status:'delivered',proof:{}}]);
 storage.getPendingPhotos.mockResolvedValue([{id:11,deliveryId:'d5',photoDataUrl:'photo'}]);
 uploadPhoto.mockResolvedValue('/photo.jpg');
 api.patch.mockResolvedValue({data:{success:true,delivery:{_id:'d5',status:'assigned'}}});
 await syncOfflineData();
 expect(storage.markQueueItemSynced).not.toHaveBeenCalled();
 expect(storage.markPhotoSynced).not.toHaveBeenCalled();
 expect(storage.updateQueueItemSyncStatus).toHaveBeenCalledWith(5,'failed',expect.stringContaining('not confirmed'));
});
test('interrupted syncing resumes after reopening and retains its photo until server acknowledgement',async()=>{
 const item={id:6,deliveryId:'d6',status:'delivered',lastSyncAttempt:new Date(Date.now()-180000).toISOString(),proof:{}};
 let recovered=false;
 storage.getQueueItemsByStatus.mockImplementation(async status=>status==='syncing'&&!recovered?[item]:[]);
 storage.updateQueueItemSyncStatus.mockImplementation(async(_id,status)=>{if(status==='pending')recovered=true;});
 storage.getPendingSyncQueue.mockImplementation(async()=>recovered?[item]:[]);
 storage.getPendingPhotos.mockResolvedValue([{id:12,deliveryId:'d6',photoDataUrl:'photo'}]);
 uploadPhoto.mockResolvedValue('/photo.jpg');
 api.patch.mockResolvedValue({data:{success:true,delivery:{_id:'d6',status:'delivered'}}});
 expect(await hasPendingSync()).toBe(true);
 await syncOfflineData();
 expect(storage.updateQueueItemSyncStatus).toHaveBeenCalledWith(6,'pending');
 expect(storage.markQueueItemSynced).toHaveBeenCalledWith(6);
 expect(storage.markPhotoSynced).toHaveBeenCalledWith(12);
});
test('photos associated with recently syncing or failed work are never treated as orphaned',async()=>{
 storage.getPendingPhotos.mockResolvedValue([{id:13,deliveryId:'d7',photoDataUrl:'photo'}]);
 storage.getQueueItemsByStatus.mockImplementation(async status=>status==='syncing'?[{id:7,deliveryId:'d7',lastSyncAttempt:new Date().toISOString()}]:[]);
 await syncOfflineData();
 expect(uploadPhoto).not.toHaveBeenCalled();
 expect(storage.markPhotoSynced).not.toHaveBeenCalled();
 expect(syncAttemptTime('2026-10-24T00:00:00Z')).toBe(Date.parse('2026-10-24T00:00:00Z'));
});
test('manual retry uses the queue record id rather than the delivery Mongo id',async()=>{
 storage.getQueueItemsByStatus.mockImplementation(async status=>status==='failed'?[{id:8,deliveryId:'mongo-id'}]:[]);
 await retryDeliverySync('mongo-id');
 expect(storage.updateQueueItemSyncStatus).toHaveBeenCalledWith(8,'pending');
 expect(storage.updateQueueItemSyncStatus).not.toHaveBeenCalledWith('mongo-id','pending');
});
