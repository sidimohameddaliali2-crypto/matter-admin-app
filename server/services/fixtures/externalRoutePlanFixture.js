import { validatePlan } from '../externalRoutePlan.js';
export const ids = { bike: '100000000000000000000001', van: '100000000000000000000002', van2: '100000000000000000000003', d1: '200000000000000000000001', d2: '200000000000000000000002', d3: '200000000000000000000003' };
export function fixture() {
  const point = { lat: 25.1, lng: 55.2, name: 'Fixture hub' };
  const cargo = (id, n) => ({ deliveryId: id, bagIds: [`FIXTURE-BAG-${n}`] });
  const customer = (id, n) => ({ id: `c${n}`, type: 'customer', deliveryId: id, point, earliestAt: '2026-10-14T02:00:00+04:00', plannedArrivalAt: `2026-10-14T02:${n}0:00+04:00`, plannedCompletionAt: `2026-10-14T02:${n}5:00+04:00`, planByAt: '2026-10-14T04:30:00+04:00', deadlineAt: '2026-10-14T05:00:00+04:00' });
  return validatePlan({ serviceDate: '2026-10-14', revision: 1, expectedRevision: 0, requestId: 'fixture-import-1', routes: [
    { driverId: ids.bike, vehicleType: 'bike', vehicleLabel: 'Bike A', initialBatchId: 'INITIAL-BIKE-A', initialCargo: [cargo(ids.d1, 1)], stops: [customer(ids.d1, 1), { id: 'p1', type: 'pickup', transferId: 't1' }, customer(ids.d2, 2), { id: 'p2', type: 'pickup', transferId: 't2' }, customer(ids.d3, 3)] },
    { driverId: ids.van, vehicleType: 'van', vehicleLabel: 'Van A', initialBatchId: 'INITIAL-VAN-A', hub: point, initialCargo: [cargo(ids.d2, 2)], stops: [] },
    { driverId: ids.van2, vehicleType: 'van', vehicleLabel: 'Van B', initialBatchId: 'INITIAL-VAN-B', hub: { ...point, lng: 55.3 }, initialCargo: [cargo(ids.d3, 3)], stops: [] }
  ], transfers: [
    { id: 't1', batchId: 'BATCH-1', vanDriverId: ids.van, bikeDriverId: ids.bike, point, pickupAt: '2026-10-14T02:16:00+04:00', plannedDepartureAt: '2026-10-14T02:18:00+04:00', cargo: [cargo(ids.d2, 2)] },
    { id: 't2', batchId: 'BATCH-2', vanDriverId: ids.van2, bikeDriverId: ids.bike, point: { ...point, lng: 55.3 }, pickupAt: '2026-10-14T02:26:00+04:00', plannedDepartureAt: '2026-10-14T02:28:00+04:00', cargo: [cargo(ids.d3, 3)] }
  ] });
}
