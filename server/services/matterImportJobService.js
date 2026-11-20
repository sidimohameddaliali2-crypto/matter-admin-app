import crypto from 'node:crypto';
import MatterImportJob from '../models/MatterImportJob.js';
import TrackerSyncLease from '../models/TrackerSyncLease.js';
import { importMatterDeliveriesForDate } from './matterDeliveryImportService.js';

const LEASE_MS = 2 * 60 * 1000;
const LOCK = 'matter-delivery-import-worker';
export function publicImportJob(job) {
  if (!job) return null;
  const { _id, date, status, progress, result, message, createdAt, startedAt, finishedAt } = job;
  return { id: String(_id), date, status, progress, result, message, createdAt, startedAt, finishedAt };
}

export function createMatterImportJobs({ Job = MatterImportJob, Lease = TrackerSyncLease,
  runImport = importMatterDeliveriesForDate, clock = () => new Date() } = {}) {
  let working = false;
  const recover = async () => {
    // Do not silently resume writes after a restart. Retain partial progress and
    // require a deliberate retry; the import's existing duplicate checks apply.
    await Job.updateMany({ status: 'running', leaseUntil: { $lte: clock() } }, {
      $set: { status: 'failed', finishedAt: clock(), message: 'Import worker was interrupted. Review the saved progress and retry; existing deliveries will be checked.' },
      $unset: { activeKey: 1, owner: 1, leaseUntil: 1 }
    });
  };
  return {
    async enqueue(date, requestedBy) {
      // The worker performs recovery before claiming; enqueue never starts an
      // upstream request or creates a delivery in the HTTP request lifecycle.
      await Job.init();
      try { return publicImportJob((await Job.create({ date, activeKey: date, status: 'queued', requestedBy,
        progress: { phase: 'queued', completed: 0, total: 0 } })).toObject()); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await Job.findOne({ activeKey: date }).lean();
        if (!existing) throw error;
        return publicImportJob(existing);
      }
    },
    async latest(date) { return publicImportJob(await Job.findOne({ date }).sort({ createdAt: -1 }).lean()); },
    async get(id) { return publicImportJob(await Job.findById(id).lean()); },
    async tick() {
      if (working) return;
      working = true;
      const owner = crypto.randomUUID();
      let acquired = false;
      let job;
      let heartbeat;
      let lost = false;
      const interrupted = () => Object.assign(new Error('Import ownership lost'), { code: 'MATTER_IMPORT_INTERRUPTED' });
      const guard = async () => {
        if (lost) throw interrupted();
        const lease = await Lease.updateOne({ _id: LOCK, owner, expiresAt: { $gt: clock() } },
          { $set: { expiresAt: new Date(+clock() + LEASE_MS) } });
        if (lease.matchedCount !== 1) { lost = true; throw interrupted(); }
        const saved = await Job.updateOne({ _id: job._id, owner, status: 'running' },
          { $set: { leaseUntil: new Date(+clock() + LEASE_MS) } });
        if (saved.matchedCount !== 1) { lost = true; throw interrupted(); }
      };
      try {
        let lease;
        try { lease = await Lease.findOneAndUpdate({ _id: LOCK, expiresAt: { $lte: clock() } },
          { $set: { owner, expiresAt: new Date(+clock() + LEASE_MS) } }, { upsert: true, new: true }); }
        catch (error) { if (error.code === 11000) return; throw error; }
        if (lease?.owner !== owner) return;
        acquired = true;
        await recover();
        job = await Job.findOneAndUpdate({ status: 'queued' }, { $set: { status: 'running', owner,
          startedAt: clock(), leaseUntil: new Date(+clock() + LEASE_MS), progress: { phase: 'listing', completed: 0, total: 0 } } },
        { sort: { createdAt: 1 }, new: true }).lean();
        if (!job) return;
        heartbeat = setInterval(() => { guard().catch(() => { lost = true; }); }, 15000);
        heartbeat.unref?.();
        let progressQueue = Promise.resolve();
        const onProgress = progress => {
          if (progress.phase === 'checking' && progress.completed % 10 !== 0 && progress.completed !== progress.total) return progressQueue;
          progressQueue = progressQueue.then(async () => {
            await guard();
            const saved = await Job.updateOne({ _id: job._id, owner, status: 'running' }, { $set: { progress } });
            if (saved.matchedCount !== 1) { lost = true; throw interrupted(); }
          });
          return progressQueue;
        };
        const result = await runImport(job.date, { onProgress, assertActive: guard });
        await guard();
        await Job.updateOne({ _id: job._id, owner, status: 'running' }, {
          $set: { status: result.complete === false ? 'incomplete' : 'completed', result, finishedAt: clock(),
            progress: { phase: 'finished', completed: result.total, total: result.total },
            message: result.complete === false ? 'Import incomplete. Review the failures before retrying.' : 'Import finished.' },
          $unset: { activeKey: 1, owner: 1, leaseUntil: 1 }
        });
      } catch (error) {
        if (job && !lost) await Job.updateOne({ _id: job._id, owner, status: 'running' }, {
          $set: { status: 'failed', finishedAt: clock(), message: 'Import failed. Review saved progress and retry. If it repeats, contact an administrator.' },
          $unset: { activeKey: 1, owner: 1, leaseUntil: 1 }
        });
        if (!job) throw error;
      } finally {
        clearInterval(heartbeat);
        try { if (acquired) await Lease.deleteOne({ _id: LOCK, owner }); }
        finally { working = false; }
      }
    }
  };
}

export const matterImportJobs = createMatterImportJobs();
