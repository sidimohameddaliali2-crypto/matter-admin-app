import express from 'express';
import { protect } from '../middleware/auth.js';
import { loadServiceAccess } from '../middleware/serviceAccess.js';
import { SERVICE_CATEGORIES, SERVICE_TAXONOMY_VERSION, SERVICE_RUBRIC_VERSION } from '../config/customerServiceCategories.js';
import {
  claimNextReview, saveReviewDraft, submitServiceReview, skipServiceReview, reassignServiceReview,
  createServiceAction, updateServiceAction, allocateServiceReviews, configureServiceStaff,
  getServiceTeam, getServiceOwners, getScopedServiceData, getServiceIssueDetail,
  requestServiceCorrection, createServiceCalibration, resolveServiceCorrection, createServiceEpisode,
} from '../services/customerServiceWorkflow.js';

const router = express.Router();
const endpoint = handler => async (req, res) => {
  try { const data = await handler(req); res.json({ success: true, data }); }
  catch (error) {
    const status = error.code === 11000 ? 409 : error.statusCode || (['ValidationError', 'CastError'].includes(error.name) ? 400 : 503);
    res.status(status).json({ success: false, message: error.code === 11000 ? 'A matching record already exists. Reload before retrying.' : error.statusCode ? error.message : status === 400 ? 'Provide valid customer-service fields.' : 'Customer-service data could not be saved or loaded. Your last saved work is retained; retry when the service is available.' });
  }
};
const actor = req => ({ actor: req.user, profile: req.serviceProfile });
const fields = (req, keys) => Object.fromEntries(keys.filter(key => req.body?.[key] !== undefined).map(key => [key, req.body[key]]));
const staffFields = ['userId', 'mode', 'enabled', 'availableMinutes', 'displayName', 'externalAuthorIds', 'availabilityDate', 'reason', 'requestId'];
router.use(protect, loadServiceAccess);
router.get('/me', endpoint(req => ({ capabilities: req.serviceCapabilities, profile: req.serviceProfile })));
// Initial setup exposes a minimal existing-account selector, never the staff
// administration document, password fields or arbitrary customer records.
router.get('/team', endpoint(req => getServiceTeam(actor(req))));
router.put('/team', endpoint(async req => ({ profile: await configureServiceStaff({ ...fields(req, staffFields), actor: req.user }) })));
router.post('/setup', endpoint(async req => ({ profile: await configureServiceStaff({ ...fields(req, staffFields), mode: 'supervisor', actor: req.user }) })));
router.use((req, res, next) => req.serviceCapabilities.view ? next() : res.status(403).json({ success: false, message: 'Active customer-service membership required.' }));
router.get('/categories', endpoint(() => SERVICE_CATEGORIES));
router.get('/policy', endpoint(() => ({ taxonomyVersion: SERVICE_TAXONOMY_VERSION, rubricVersion: SERVICE_RUBRIC_VERSION, pendingCap: 2, activeCap: 1, leaseMinutes: 15 })));
router.get('/owners', endpoint(async () => ({ owners: await getServiceOwners() })));
router.get('/reviews', endpoint(async req => ({ reviews: (await getScopedServiceData({ ...actor(req), filters: req.query })).reviews })));
router.post('/reviews/next', endpoint(async req => ({ review: await claimNextReview({ actor: req.user, requestId: req.body?.requestId }) })));
router.put('/reviews/:id/draft', endpoint(async req => ({ review: await saveReviewDraft({ reviewId: req.params.id, version: req.body?.version, draft: req.body?.draft, actor: req.user }) })));
router.post('/reviews/:id/submit', endpoint(req => submitServiceReview({ ...fields(req, ['version', 'sourceRevision', 'verdict', 'summary', 'categoryIds', 'outcome', 'note', 'evidenceMessageIds', 'action', 'requestId', 'confirmIssueBoundary']), reviewId: req.params.id, actor: req.user })));
router.post('/reviews/:id/skip', endpoint(async req => ({ review: await skipServiceReview({ ...fields(req, ['version', 'reason', 'requestId']), reviewId: req.params.id, actor: req.user }) })));
router.post('/reviews/:id/reassign', endpoint(async req => ({ review: await reassignServiceReview({ ...fields(req, ['ownerId', 'reason', 'version', 'requestId']), reviewId: req.params.id, actor: req.user }) })));
router.post('/reviews/:id/corrections', endpoint(async req => ({ review: await requestServiceCorrection({ ...fields(req, ['version', 'reason', 'requestId']), reviewId: req.params.id, actor: req.user }) })));
router.post('/reviews/:id/corrections/:index/resolve', endpoint(async req => ({ review: await resolveServiceCorrection({ ...fields(req, ['version', 'decision', 'resolution', 'ownerId', 'requestId']), index: /^\d+$/.test(req.params.index) ? Number(req.params.index) : -1, reviewId: req.params.id, actor: req.user }) })));
router.post('/reviews/:id/calibration', endpoint(async req => ({ review: await createServiceCalibration({ ...fields(req, ['ownerId', 'requestId']), reviewId: req.params.id, actor: req.user }) })));
router.get('/issues', endpoint(async req => { const { issues, actions } = await getScopedServiceData({ ...actor(req), filters: req.query }); return { issues, actions }; }));
router.get('/issues/:id', endpoint(req => getServiceIssueDetail({ issueId: req.params.id, ...actor(req) })));
router.post('/issues/:id/episodes', endpoint(req => createServiceEpisode({ ...fields(req, ['version', 'evidenceMessageIds', 'summary', 'categoryIds', 'requestId']), issueId: req.params.id, actor: req.user })));
router.post('/issues/:id/actions', endpoint(async req => ({ action: await createServiceAction({ ...fields(req, ['description', 'ownerId', 'dueAt', 'promisedDueAt', 'promiseMessageId', 'note', 'requestId']), issueId: req.params.id, actor: req.user }) })));
router.patch('/actions/:id', endpoint(async req => ({ action: await updateServiceAction({ ...fields(req, ['version', 'status', 'ownerId', 'reason', 'note', 'dueAt', 'nextCheckAt', 'evidence', 'requestId']), id: req.params.id, actor: req.user }) })));
router.post('/allocate', endpoint(req => allocateServiceReviews({ actor: req.user, requestId: req.body?.requestId })));
export default router;
