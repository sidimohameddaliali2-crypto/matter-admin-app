import api from './api';
import {syncOfflineData} from './offlineSync';
import {uploadPhoto} from './fileUpload';
import * as storage from './offlineStorage';
jest.mock('./api',()=>({__esModule:true,default:{post:jest.fn(),patch:jest.fn()}}));
jest.mock('./fileUpload',()=>({uploadPhoto:jest.fn()}));
jest.mock('./offlineStorage',()=>({getPendingPhotos:jest.fn(),getPendingSyncQueue:jest.fn(),markPhotoSynced:jest.fn(),markQueueItemSynced:jest.fn(),cleanupOldPhotos:jest.fn(),cleanupOldQueueItems:jest.fn(),updateQueueItemSyncStatus:jest.fn(),getQueueItemsByStatus:jest.fn()}));
beforeEach(()=>{Object.values(storage).filter(jest.isMockFunction).forEach(fn=>fn.mockReset());api.post.mockReset();api.patch.mockReset();uploadPhoto.mockReset();storage.getPendingPhotos.mockResolvedValue([]);storage.getPendingSyncQueue.mockResolvedValue([]);Object.defineProperty(navigator,'onLine',{configurable:true,value:true});jest.spyOn(console,'log').mockImplementation(()=>{});jest.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>jest.restoreAllMocks());
test('offline collection keeps its typed proof and sends no reassignment or warehouse return',async()=>{
  storage.getPendingSyncQueue.mockResolvedValue([{id:1,deliveryId:'d1',status:'completed',bagIds:['BAG-0001'],proof:{type:'bag_collection',scannedBags:['BAG-0001']}}]);
  api.patch.mockResolvedValue({data:{success:true}});await syncOfflineData();
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
