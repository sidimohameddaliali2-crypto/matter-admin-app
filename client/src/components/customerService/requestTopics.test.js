import {workflowTopic,topicName,topicDetailName} from './requestTopics';

const definitions={topics:[{id:'tag_plan',label:'Plan & Subscription',includes:[{id:'subscription_pause',label:'Subscription Pause',workflowTopic:'pause'}]}],legacyTopics:[{id:'pause',label:'Skip / Pause',group:'Subscription'}]};
test('explicit tag detail chooses the action family and preserves tag/detail display labels',()=>{
 const classification={topic:'tag_plan',subtopic:'subscription_pause'};
 expect(workflowTopic(classification,definitions)).toBe('pause');expect(topicName(classification,definitions)).toBe('Plan & Subscription');expect(topicDetailName(classification,definitions)).toBe('Subscription Pause');
});
test('legacy and unsupported classifications are not silently mapped into current tags',()=>{
 expect(workflowTopic({topic:'pause'},definitions)).toBe('pause');expect(topicName({topic:'pause'},definitions)).toBe('Skip / Pause');expect(topicDetailName({topic:'pause'},definitions)).toBe('');
 expect(workflowTopic({topic:'tag_plan',subtopic:'wrong_detail'},definitions)).toBe('tag_plan');expect(topicDetailName({topic:'tag_plan',subtopic:'wrong_detail'},definitions)).toBe('');expect(topicName({topic:'unknown',group:'Recorded group'},definitions)).toBe('Recorded group');
});
test('missing classifications produce empty helper values',()=>{
 expect(workflowTopic(null,definitions)).toBe('');expect(topicName(null,definitions)).toBe('');expect(topicDetailName(null,definitions)).toBe('');
});
