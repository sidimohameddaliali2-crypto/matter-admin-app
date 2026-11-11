import {PERMISSION_GROUPS,PERMISSION_KEYS,getDefaultPermissions} from './permissions';

test('Customer Service is an independent selectable page permission beside existing customer pages',()=>{
 const customers=PERMISSION_GROUPS.find(group=>group.label==='Customers');
 expect(customers.items.find(item=>item.key==='customer_service')?.label).toBe('Customer Service');
 expect(PERMISSION_KEYS.filter(key=>key==='customer_service')).toHaveLength(1);
 expect(PERMISSION_KEYS).toEqual(expect.arrayContaining(['customers','reports','complaints','menus','customer_service']));
 expect(getDefaultPermissions('super_admin').customer_service).toBe(true);
 expect(getDefaultPermissions('viewer').customer_service).toBe(false);
 expect(getDefaultPermissions('driver').customer_service).toBe(false);
});
