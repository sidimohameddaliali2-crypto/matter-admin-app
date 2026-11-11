import {installCustomerServiceDestination} from './customerServiceDestination.js';
import customerServiceRoutes from '../routes/customerService.js';
import customerServiceData from '../routes/customerServiceData.js';
import customerServiceCustomers from '../routes/customerServiceCustomers.js';
import customerServiceMedia from '../routes/customerServiceMedia.js';
import customerServiceGallabox from '../routes/customerServiceGallabox.js';

// Consume the canonical Supabase workflow. No alternate Mongo store, login
// route, collector, account/grant seeding or migration starts here.
export function mountCustomerServiceInAdmin({app,env=process.env,...options}){
 if(env.CUSTOMER_SERVICE_STORAGE!=='supabase'){
  app.use(['/api/customer-service','/api/customer-service-capture'],(req,res)=>res.status(503).set('Cache-Control','no-store').json({success:false,message:'Customer service requires its canonical Supabase connection. Saved work is retained.'}));
  return {hosted:true,ready:Promise.resolve(null)};
 }
 const runtime=installCustomerServiceDestination({app,env,...options});
 app.use('/api/customer-service',customerServiceMedia);
 app.use('/api/customer-service/gallabox',customerServiceGallabox);
 app.use('/api/customer-service',customerServiceCustomers,customerServiceData,customerServiceRoutes);
 return runtime;
}
