const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
export const formatDubai=value=>!value||Number.isNaN(new Date(value).getTime())?'Not recorded':formatter.format(new Date(value));
