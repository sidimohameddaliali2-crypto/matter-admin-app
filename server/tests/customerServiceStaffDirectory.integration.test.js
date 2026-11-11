import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';
import {createCloudStore,configureCloudInbox} from '../services/customerServiceCloudStore.js';
import {createCloudTransportFromPool} from '../services/customerServiceCloudTransport.js';
import {resolveStaffLogin} from '../services/customerServiceStaffDirectory.js';
const enabled=process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true'&&process.env.CUSTOMER_SERVICE_CLOUD_TEST==='true';
test('one-query login resolution retains immediate revocation and exact provider binding',{skip:!enabled},async()=>{
 const database='gallabox_login_'+Date.now(),admin=new pg.Pool({host:'127.0.0.1',port:65436,user:'gallabox_test',database:'postgres'});let pool;
 try{await admin.query('CREATE DATABASE '+database);pool=new pg.Pool({host:'127.0.0.1',port:65436,user:'gallabox_test',database});await pool.query("CREATE SCHEMA gallabox_private;CREATE TABLE gallabox_private.staff_directory(id text primary key,display_name text,email text,active boolean);CREATE TABLE gallabox_private.staff_login(provider text,subject text,staff_id text,active boolean);INSERT INTO gallabox_private.staff_directory VALUES('staff','Isolated staff','fixture@example.invalid',true);INSERT INTO gallabox_private.staff_login VALUES('matter','subject','staff',true),('supabase','alternate','staff',true);");
 const store=createCloudStore({transport:createCloudTransportFromPool(async()=>pool)});let queries=0;const query=store.query.bind(store);store.query=(...args)=>{queries++;return query(...args);};configureCloudInbox({store,workflow:true});
 const user=await resolveStaffLogin('matter','subject');assert.equal(queries,1);assert.equal(user._id,'staff');assert.equal(user.email,'fixture@example.invalid');assert.equal(user.serviceOnly,true);assert.equal(await resolveStaffLogin('supabase','subject'),null);
 await pool.query("UPDATE gallabox_private.staff_login SET active=false WHERE provider='matter'");assert.equal(await resolveStaffLogin('matter','subject'),null);assert.equal((await resolveStaffLogin('supabase','alternate'))._id,'staff');
 await pool.query('UPDATE gallabox_private.staff_directory SET active=false');assert.equal(await resolveStaffLogin('supabase','alternate'),null);
 }finally{configureCloudInbox(null);await pool?.end();await admin.query('DROP DATABASE IF EXISTS '+database);await admin.end();}
});
