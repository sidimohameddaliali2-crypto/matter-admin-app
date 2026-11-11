const topicFor=(classification,definitions)=>definitions?.topics?.find(topic=>topic.id===classification?.topic);
const detailFor=(classification,definitions)=>topicFor(classification,definitions)?.includes?.find(detail=>detail.id===classification?.subtopic);

// Existing 17-family classifications remain their original stored values.
// A current tag's explicitly selected include chooses its trusted action family.
export function workflowTopic(classification,definitions) {
 if(!classification)return '';
 return detailFor(classification,definitions)?.workflowTopic||classification.topic||'';
}

export function topicName(classification,definitions) {
 if(!classification)return '';
 return topicFor(classification,definitions)?.label||definitions?.legacyTopics?.find(topic=>topic.id===classification.topic)?.label||classification.group||'Not classified';
}

export function topicDetailName(classification,definitions) {
 if(!classification)return '';
 return detailFor(classification,definitions)?.label||'';
}
