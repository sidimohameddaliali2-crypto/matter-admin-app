// Traffic and publication are committed before retirement. The job owner is
// deliberately outside this state machine and must never be restarted here.
export async function handoffApi({ candidate, previous, ops }) {
  let switched = false, website, committed = false, cutover;
  await ops.recordPending({ candidate, previous, phase: 'starting' });
  try {
    await ops.start(candidate);
    await ops.ready(candidate);
    switched = true;
    cutover = await ops.switchTraffic(candidate.port, previous.port);
    await ops.publicReady(candidate);
    website = await ops.publishWebsite();
    await ops.commit({ candidate, previous, drainToken: cutover.drainToken });
    committed = true;
  } catch (error) {
    if (!committed) {
      // If rollback cannot be verified, leave both processes running and retain
      // the pending receipt. Do not guess which one gateway currently serves.
      try {
        let rollback;
        if (website?.changed) await ops.rollbackWebsite();
        if (switched) {
          rollback = await ops.restoreTraffic(previous, candidate);
          await ops.publicReady(previous);
        }
        await ops.discard(candidate, { previous, mayHaveServed: switched, drainToken: rollback?.drainToken });
        await ops.clearPending();
      } catch {
        throw Error('API rollback needs operator attention; both releases and pending evidence are retained.');
      }
    }
    throw error;
  }
  await ops.clearPending();
  // A drain timeout is not permission to kill an in-flight request. Retain the
  // old web process and block further deploys until its retirement is verified.
  let retirementPending = false;
  if (previous.role === 'web') {
    try { await ops.retire(previous, cutover.drainToken); }
    catch { retirementPending = true; }
  }
  await ops.retirementResult({ previous, retirementPending });
  return { releaseId: candidate.releaseId, committed: true, retirementPending };
}
