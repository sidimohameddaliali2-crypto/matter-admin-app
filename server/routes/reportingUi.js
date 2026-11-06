import express from 'express';
import {protect,checkPermission} from '../middleware/auth.js';
import {createReportingUiGateway} from '../services/reportingUiGateway.js';
import {createReportingUpstream} from '../services/reportingUpstream.js';
const enabled=process.env.ENABLE_REPORTING_WORKSPACE==='true';
// No source calls or sessions are created when disabled. Configuration fails closed.
const router=createReportingUiGateway({express,protect,checkPermission,enabled,...(enabled?{
 origin:process.env.REPORTING_APP_ORIGIN,
 upstream:createReportingUpstream({baseUrl:process.env.REPORTING_SERVICE_ORIGIN,credential:process.env.REPORTING_SERVICE_CREDENTIAL})
}:{})});
export default router;
