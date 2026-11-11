const DAY = 86400000;
export const TIMING_LABELS = Object.freeze({early:'Early',on:'On time',late:'Late',unknown:'Missing timing'});

export function dubaiToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  return [part('year'),part('month'),part('day')].join('-');
}
export function isDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value;
}
export function shiftDay(day, count) {
  return new Date(Date.parse(day + 'T00:00:00Z') + count * DAY).toISOString().slice(0,10);
}
export function rangeFor(preset, today, records = [], custom = {}) {
  if (!isDay(today)) throw new Error('Today must be a valid Dubai calendar date.');
  if (preset === 'today') return {start:today,end:today};
  if (preset === 'custom') {
    if (!isDay(custom.start) || !isDay(custom.end)) throw new Error('Choose valid start and end dates.');
    if (custom.start > custom.end) throw new Error('Start date must be on or before the end date.');
    if (custom.end > today) throw new Error('History can include dates through today.');
    return {start:custom.start,end:custom.end};
  }
  if (preset === 'all') {
    const dates = records.map(r => r.date).filter(d => isDay(d) && d <= today).sort();
    return {start:dates[0] || today,end:today};
  }
  if (preset === 'year') {
    const date = new Date(today + 'T00:00:00Z');
    date.setUTCFullYear(date.getUTCFullYear() - 1);
    return {start:date.toISOString().slice(0,10),end:shiftDay(today,-1)};
  }
  const days = Number(preset);
  if (![7,30,90].includes(days)) throw new Error('Choose a supported date range.');
  return {start:shiftDay(today,-days),end:shiftDay(today,-1)};
}
export function savedDeliveryRecords(rows) {
  // Scheduled time and updatedAt are not proof of a delivery outcome.
  return rows.filter(r => isDay(r.date)).map(r => ({
    id:r.deliveryId,date:r.date,name:r.name,customerId:r.customerId,status:r.status,
    scheduled:r.time || null,zone:r.zone ?? null,driver:r.driver ?? null,
    timing:'unknown',lateMinutes:null,variance:null,original:r,
  }));
}
const dubaiDayFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'});
const dubaiClockFormatter = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const apiTimingLabels = new Map([['early','early'],['on-time','on'],['late','late']]);
function validTimestamp(value) {
  // An actual time needs an explicit zone; date-only and naive times are not outcomes.
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && isDay(value.slice(0,10)) && Number.isFinite(Date.parse(value));
}
export function dubaiTimestampDay(value) {
  if (!validTimestamp(value)) return null;
  const parts = dubaiDayFormatter.formatToParts(new Date(value));
  return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');
}
export function apiDeliveryRecords(rows) {
  const minutes = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return rows.map(row => {
    const date = dubaiTimestampDay(row.scheduledTime);
    const deliveredAt = validTimestamp(row.deliveredTime) ? row.deliveredTime : null;
    // The API defaults pending/assigned records to "on-time". A completed outcome
    // and an actual timestamp are required before accepting that reported label.
    const completed = ['delivered','completed'].includes(row.status) && deliveredAt !== null;
    const reported = apiTimingLabels.get(row.timingStatus);
    const timing = completed && reported ? reported : 'unknown';
    const lateMinutes = timing === 'late' ? minutes(row.lateMinutes) : null;
    const earlyMinutes = timing === 'early' ? minutes(row.earlyMinutes) : null;
    const varianceMinutes = timing === 'late' ? lateMinutes : earlyMinutes;
    return {
      id:row.id,date,name:row.customerName,customerId:row.customerId,status:row.status,
      scheduled:date ? dubaiClockFormatter.format(new Date(row.scheduledTime)) : null,
      scheduledAt:date ? row.scheduledTime : null,deliveredAt,timing,lateMinutes,
      zone:row.zone ?? null,driver:row.driverName ?? null,
      variance:varianceMinutes === null ? null : varianceMinutes+' min '+timing,original:row,
    };
  }).filter(row=>isDay(row.date));
}
export function reportedExceptionRecords(rows) {
  return rows.map(r => {
    // These are already-rendered source dates and variances, not UTC timestamps.
    const scheduled = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}:\d{2}:\d{2})$/.exec(r.scheduled || '');
    const date = scheduled ? [scheduled[3],scheduled[2],scheduled[1]].join('-') : null;
    const variance = /^(\d+(?:\.\d+)?) min (early|late)$/.exec(r.variance || '');
    return {
      id:r.id,date,name:r.name,customerId:r.customerId,status:r.status,
      scheduled:scheduled?.[4] || null,timing:variance?.[2] || 'unknown',
      lateMinutes:variance?.[2] === 'late' ? Number(variance[1]) : null,
      variance:r.variance || null,zone:r.zone ?? null,driver:r.driver ?? null,original:r,
    };
  }).filter(r => isDay(r.date));
}
export function periodRecords(records, range) {
  return records.filter(r => r.date >= range.start && r.date <= range.end);
}
export function totals(records, rateEligible = true) {
  const result = {total:records.length,early:0,on:0,late:0,unknown:0,recorded:0,onTimeRate:null};
  for (const record of records) result[record.timing in TIMING_LABELS ? record.timing : 'unknown']++;
  result.recorded = result.early + result.on + result.late;
  // An exception-only list cannot supply an unbiased on-time denominator.
  if (rateEligible && result.recorded) result.onTimeRate = result.on / result.recorded * 100;
  return result;
}
export function groupRecords(records, range) {
  const span = (Date.parse(range.end) - Date.parse(range.start)) / DAY + 1;
  if (span === 1) {
    const buckets = Array.from({length:24},(_,hour)=>({
      key:range.start+'T'+String(hour).padStart(2,'0'),...range,
      hourStart:String(hour).padStart(2,'0')+':00',
      hourEnd:String(hour+1).padStart(2,'0')+':00',records:[],
    }));
    const unavailable = {key:range.start+'Tunknown',...range,hourStart:null,hourEnd:null,records:[]};
    for (const record of periodRecords(records,range)) {
      // Adapters retain the source's scheduled clock in Dubai. Never infer an
      // actual delivery hour from a scheduled time, update time or status.
      const clock = /^(\d{2}):([0-5]\d)(?::[0-5]\d)?$/.exec(record.scheduled || '');
      const hour = clock ? Number(clock[1]) : null;
      (hour !== null && hour < 24 ? buckets[hour] : unavailable).records.push(record);
    }
    if (unavailable.records.length) buckets.push(unavailable);
    return {grouping:'hour',buckets:buckets.map(bucket=>({...bucket,...totals(bucket.records)}))};
  }
  const grouping = span <= 31 ? 'day' : span <= 120 ? 'week' : 'month';
  const groups = new Map();
  for (const record of periodRecords(records,range)) {
    let start = record.date;
    if (grouping === 'week') {
      const weekday = new Date(start + 'T00:00:00Z').getUTCDay();
      start = shiftDay(start,-((weekday+6)%7));
    } else if (grouping === 'month') start = start.slice(0,7) + '-01';
    if (!groups.has(start)) groups.set(start,[]);
    groups.get(start).push(record);
  }
  const buckets = [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,items])=>{
    let end = key;
    if (grouping === 'week') end = shiftDay(key,6);
    if (grouping === 'month') {
      const date = new Date(key + 'T00:00:00Z');
      end = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).toISOString().slice(0,10);
    }
    return {key,start:key<range.start?range.start:key,end:end>range.end?range.end:end,records:items,...totals(items)};
  });
  return {grouping,buckets};
}
export function latenessMeasures(records, threshold) {
  const minutes = records.filter(r => r.timing === 'late' && Number.isFinite(r.lateMinutes) && r.lateMinutes >= 0).map(r => r.lateMinutes).sort((a,b) => a-b);
  if (!minutes.length) return {median:null,over:null,measured:0};
  const mid = Math.floor(minutes.length / 2);
  return {median:minutes.length % 2 ? minutes[mid] : (minutes[mid-1]+minutes[mid])/2,over:minutes.filter(n => n > threshold).length,measured:minutes.length};
}
export function filterRecords(records, timing = 'all', search = '', dimensions = {}) {
  const term = search.trim().toLocaleLowerCase();
  const matches = (value, choice) => !choice || (choice === '__missing__' ? value == null || String(value).trim() === '' : value === choice);
  return records.filter(r => (timing === 'all' || r.timing === timing)
    && matches(r.zone,dimensions.zone) && matches(r.driver,dimensions.driver) && matches(r.status,dimensions.status)
    && (!dimensions.customerId || r.customerId === dimensions.customerId)
    && (!term || [r.id,r.name,r.customerId,r.status,r.date,r.zone,r.driver].some(v => String(v ?? '').toLocaleLowerCase().includes(term))));
}
// A chart selection narrows only the records table, inside its existing page
// population. Use scheduled Dubai clocks, including the unavailable-hour bucket.
export function bucketRecords(records, bucket) {
  if (!bucket) return records;
  return periodRecords(records,bucket).filter(record => {
    if (bucket.hourStart === undefined) return true;
    const clock = /^(\d{2}):([0-5]\d)(?::[0-5]\d)?$/.exec(record.scheduled || '');
    const hour = clock && Number(clock[1]) < 24 ? clock[1]+':00' : null;
    return hour === bucket.hourStart;
  });
}
export function pageRecords(records, page, size = 25) {
  const lastPage = Math.max(0,Math.ceil(records.length / size)-1);
  const safePage = Math.max(0,Math.min(page,lastPage));
  return {page:safePage,lastPage,rows:records.slice(safePage*size,(safePage+1)*size)};
}
export function exportRecords(records, sourceLabel) {
  return records.map(r => ({
    record:r.id,date:r.date,customer:r.name,customerId:r.customerId,status:r.status,
    timing:TIMING_LABELS[r.timing],scheduled:r.scheduled ?? '',zone:r.zone ?? '',driver:r.driver ?? '',reportedVariance:r.variance ?? '',
    scheduledAt:r.scheduledAt ?? '',actualDeliveredAt:r.deliveredAt ?? '',
    reportedLateMinutes:r.lateMinutes ?? '',source:sourceLabel,
  }));
}
