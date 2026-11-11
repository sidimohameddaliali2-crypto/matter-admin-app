// Dispatch authenticated reads before transferring/parsing the renderer bundle.
// Preserve the complete ordered bridge/queue/cache/startup chain unchanged.
export function prioritizePreviewStartup(html){
 const marker='<script>window.__matterReportingGeneration=',start=html.indexOf(marker),end=html.indexOf('</head>'),head=html.indexOf('<head>');
 if(head<0||start<head||end<start||html.indexOf(marker,start+1)!==-1)throw Error('Preview startup boundary unavailable');
 const scripts=html.slice(start,end);return html.slice(0,head+6)+scripts+html.slice(head+6,start)+html.slice(end);
}
