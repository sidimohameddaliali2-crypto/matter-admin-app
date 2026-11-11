// A completed-day marker belongs to the original frozen population. Records
// appended later with explicit source-only provenance were never in that cohort.
export function completedPhotoDay(row,days){
 const day=typeof row?.key==='string'?row.key.slice(0,10):'';
 const complete=days instanceof Set?days.has(day):Array.isArray(days)&&days.includes(day);
 if(!complete)return false;
 return row?.sourceOnly?.assessmentState!=='unavailable'||row?.photo?.reviewStatus==='reviewed'||row?.photo?.grade!=null||row?.delivery?.photo_grade!=null;
}
