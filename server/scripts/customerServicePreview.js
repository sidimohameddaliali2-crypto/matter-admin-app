// Explicit fictional rehearsals only. Production CS uses customerServiceAdminMount
// and the existing app login. Never load private reporting or live credentials.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
if(process.env.CUSTOMER_SERVICE_TEST_ISOLATED!=='true')throw Error('Use an explicitly isolated customer-service rehearsal.');
if(process.env.CUSTOMER_SERVICE_APP_LOGIN_PREVIEW==='true'){
 const {startAppLoginPreview}=await import('./customerServiceAppLoginPreview.js');await startAppLoginPreview(root);
}else if(process.env.CUSTOMER_SERVICE_ACTION_PREVIEW==='true'){
 const {startActionFixture}=await import('./customerServiceActionFixture.js');await startActionFixture(root);
}else{
 throw Error('Choose the isolated action or existing-login rehearsal.');
}
