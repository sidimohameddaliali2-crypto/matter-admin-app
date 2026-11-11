import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import mongoose from 'mongoose';
import DirectoryState from '../models/ServiceCustomerDirectoryState.js';
import Customer from '../models/ServiceCustomer.js';import Contact from '../models/ServiceSourceContact.js';import Conversation from '../models/ServiceConversation.js';import Message from '../models/ServiceMessage.js';import Issue from '../models/ServiceIssue.js';import Review from '../models/ServiceReview.js';
import {observeServiceContacts,reconcileServiceCustomerLinks,reconcileHistoricalCustomerLinks} from '../services/customerServiceIdentity.js';
const account='a'.repeat(24),historyProvenance={history:{sourceWorkbook:`messagereport-${account}_06Nov260706AM-fixture.xlsx`}};
const uri=process.env.CUSTOMER_SERVICE_TEST_MONGODB_URI,enabled=Boolean(uri&&process.env.CUSTOMER_SERVICE_TEST_ISOLATED==='true');const dbName=`matter_service_test_${randomUUID().replaceAll('-','')}`;
before(async()=>{if(!enabled)return;await mongoose.connect(uri,{dbName});for(const m of Object.values(mongoose.models)){await m.createCollection();await m.createIndexes();}await DirectoryState.create({key:'matter_customer_directory',activeGeneration:'fixture',status:'ready',lastSuccessfulAt:new Date()});});
after(async()=>{if(!enabled)return;if(mongoose.connection.name===dbName)await mongoose.connection.dropDatabase();await mongoose.disconnect();});
test('scoped exact matching preserves reviews, revisions and old identity on conflict; native observations beat export',{skip:!enabled},async()=>{
 await Customer.create([{customerId:'matter:1',name:'One',phone:'971501234567',active:true,generation:'fixture',source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'partial'},{customerId:'matter:2',name:'Two',email:'two@fixture.invalid',active:true,generation:'fixture',source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'partial'}]);
 await observeServiceContacts({scope:'one',contacts:[{externalContactId:'contact',phone:'0501234567'}]});
 const [c,other]=await Conversation.create([{source:'gallabox',scope:'one',externalConversationId:'c',sourceRevision:7,sourceMetadata:{externalContactId:'contact'}},{source:'gallabox',scope:'two',externalConversationId:'c',sourceMetadata:{externalContactId:'contact'}}]);
 const issue=await Issue.create({conversationId:c._id,sourceRevision:7});const review=await Review.create({issueId:issue._id,reviewerId:new mongoose.Types.ObjectId(),status:'assigned'});const before=JSON.stringify(await Review.findById(review._id).lean());
 const result=await reconcileServiceCustomerLinks();assert.equal(result.matchedContacts,1);assert.equal(result.linkedConversations,1);assert.equal((await Conversation.findById(c._id)).customerId,'matter:1');assert.equal((await Conversation.findById(c._id)).sourceRevision,7);assert.equal((await Conversation.findById(other._id)).customerId,null);assert.equal(JSON.stringify(await Review.findById(review._id).lean()),before);
 const stableConversation=JSON.stringify(await Conversation.findById(c._id).lean()),stableIssue=JSON.stringify(await Issue.findById(issue._id).lean());await reconcileServiceCustomerLinks();assert.equal(JSON.stringify(await Conversation.findById(c._id).lean()),stableConversation);assert.equal(JSON.stringify(await Issue.findById(issue._id).lean()),stableIssue);
 await observeServiceContacts({scope:'one',contacts:[{externalContactId:'contact',phone:'971509999999'}],origin:'gallabox_conversation_export'});assert.equal((await Contact.findOne()).phone,'971501234567');
 await observeServiceContacts({scope:'one',contacts:[{externalContactId:'contact',email:'two@fixture.invalid'}]});assert.equal((await reconcileServiceCustomerLinks()).conflictingContacts,1);assert.equal((await Contact.findOne()).customerId,'matter:1');assert.equal((await Conversation.findById(c._id)).customerId,'matter:1');
});
test('historical group links only when all message evidence agrees with one native customer',{skip:!enabled},async()=>{
 await Contact.create({scope:`${account}:native`,externalContactId:'native-contact',customerId:'matter:1',matchState:'matched'});
 const n=await Conversation.create({source:'gallabox',scope:`${account}:native`,externalConversationId:'native',customerId:'matter:1',customerName:'One',sourceMetadata:{externalContactId:'native-contact'}});const h=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'h',sourceRevision:4});const partial=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'partial'});
 const base={sourceMetadata:historyProvenance,externalMessageId:'message1',sentAt:new Date('2026-11-01T00:00:00Z'),type:'text',text:'Fixture text',authorType:'customer'};
 await Message.create([{...base,source:'gallabox',scope:`${account}:native`,conversationId:n._id},{...base,source:'gallabox_history',scope:'book',conversationId:h._id},{...base,externalMessageId:'missing',source:'gallabox_history',scope:'book',conversationId:partial._id}]);await Issue.create({conversationId:h._id,sourceRevision:4});
 assert.deepEqual(await reconcileHistoricalCustomerLinks(),{linked:1,unresolved:1,limited:false});assert.equal((await Conversation.findById(h._id)).customerId,'matter:1');assert.equal((await Conversation.findById(h._id)).sourceRevision,4);assert.equal((await Conversation.findById(partial._id)).customerId,null);
 await Message.updateOne({source:'gallabox',externalMessageId:'message1'},{$set:{text:'Different native representation',type:'other',sentAt:new Date('2026-11-01T00:00:00.123Z')}});assert.equal((await reconcileHistoricalCustomerLinks()).linked,1);
});

test('a retained conflicted native customer never creates a new historical identity',{skip:!enabled},async()=>{
 const contact=await Contact.create({scope:`${account}:conflicted-native`,externalContactId:'contact',customerId:'matter:1',matchState:'conflict'});
 const n=await Conversation.create({source:'gallabox',scope:contact.scope,externalConversationId:'c',customerId:'matter:1',sourceMetadata:{externalContactId:contact.externalContactId}});
 const h=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'conflict-history'});
 const base={sourceMetadata:historyProvenance,externalMessageId:'conflict-message',sentAt:new Date('2026-11-02T00:00:00Z'),type:'text',text:'Exact same fixture'};
 await Message.create([{...base,source:'gallabox',scope:n.scope,conversationId:n._id},{...base,source:'gallabox_history',scope:'book',conversationId:h._id}]);
 await reconcileHistoricalCustomerLinks();assert.equal((await Conversation.findById(h._id)).customerId,null);
});
test('a concurrent native observation cannot receive an obsolete match or link its conversations',{skip:!enabled},async()=>{
 const contact=await Contact.create({scope:'race',externalContactId:'contact',phone:'971501234567'});
 const conversation=await Conversation.create({source:'gallabox',scope:'race',externalConversationId:'race',sourceMetadata:{externalContactId:'contact'}});
 const original=Contact.updateOne;let injected=false;
 Contact.updateOne=function(filter,update,options){
  if(String(filter._id)!==String(contact._id)||injected)return original.call(this,filter,update,options);
  injected=true;return (async()=>{await Contact.collection.updateOne({_id:contact._id},{$set:{phone:'971509999999',email:'two@fixture.invalid',updatedAt:new Date(Date.now()+1000)}});return original.call(this,filter,update,options);})();
 };
 try{await reconcileServiceCustomerLinks();}finally{Contact.updateOne=original;}
 assert.equal(injected,true);assert.equal((await Conversation.findById(conversation._id)).customerId,null);assert.notEqual((await Contact.findById(contact._id)).matchState,'matched');
});

test('changed native contact attributes invalidate an old match before capture; identical observations preserve it',{skip:!enabled},async()=>{
 await Contact.create({scope:'observation',externalContactId:'contact',phone:'971501234567',email:'',customerId:'matter:1',matchState:'matched',matchedBy:'exact_phone',origin:'gallabox_api'});
 await observeServiceContacts({scope:'observation',contacts:[{externalContactId:'contact',phone:'0501234567'}]});assert.equal((await Contact.findOne({scope:'observation'})).matchState,'matched');
 await observeServiceContacts({scope:'observation',contacts:[{externalContactId:'contact',phone:'971509999999'}]});const changed=await Contact.findOne({scope:'observation'});assert.equal(changed.matchState,'pending');assert.equal(changed.customerId,'matter:1');assert.equal(changed.matchedBy,'');
 await reconcileServiceCustomerLinks();assert.equal((await Contact.findOne({scope:'observation'})).matchState,'conflict');
});

test('a historical group that gains evidence during reconciliation is not linked from an old snapshot',{skip:!enabled},async()=>{
 const contact=await Contact.create({scope:`${account}:append-native`,externalContactId:'contact',customerId:'matter:1',matchState:'matched'});
 const n=await Conversation.create({source:'gallabox',scope:contact.scope,externalConversationId:'c',customerId:'matter:1',sourceMetadata:{externalContactId:contact.externalContactId}});
 const h=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'append-history'});
 const base={sourceMetadata:historyProvenance,externalMessageId:'append-message',sentAt:new Date('2026-11-02T00:00:00Z'),type:'text',text:'Exact fixture'};
 await Message.create([{...base,source:'gallabox',scope:n.scope,conversationId:n._id},{...base,source:'gallabox_history',scope:'book',conversationId:h._id}]);
 const original=Conversation.updateOne;let injected=false;
 Conversation.updateOne=function(filter,update,options){if(String(filter._id)!==String(h._id)||injected)return original.call(this,filter,update,options);injected=true;return (async()=>{await Conversation.collection.updateOne({_id:h._id},{$inc:{sourceRevision:1}});return original.call(this,filter,update,options);})();};
 try{await reconcileHistoricalCustomerLinks();}finally{Conversation.updateOne=original;}
 assert.equal(injected,true);assert.equal((await Conversation.findById(h._id)).customerId,null);
});
test('historical transcript with distinct verified contacts of one customer links without inventing a single contact',{skip:!enabled},async()=>{
 const scope=`${account}:mixed`;await Contact.create([{scope,externalContactId:'mixed-a',customerId:'matter:1',matchState:'matched'},{scope,externalContactId:'mixed-b',customerId:'matter:1',matchState:'matched'}]);
 const native=await Conversation.create(['mixed-a','mixed-b'].map(externalContactId=>({source:'gallabox',scope,externalConversationId:externalContactId,customerId:'matter:1',sourceMetadata:{externalContactId}})));
 const history=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'mixed'});
 for(let index=0;index<2;index++){const base={externalMessageId:`mixed-message-${index}`,sentAt:new Date(),type:'text',text:'Fixture',sourceMetadata:historyProvenance};await Message.create([{...base,source:'gallabox',scope,conversationId:native[index]._id},{...base,source:'gallabox_history',scope:'book',conversationId:history._id}]);}
 const issue=await Issue.create({conversationId:history._id});const review=await Review.create({issueId:issue._id,reviewerId:new mongoose.Types.ObjectId(),status:'assigned'});const reviewBefore=JSON.stringify(await Review.findById(review._id).lean());const originalMessages=await Message.find({conversationId:history._id}).select('text type sentAt externalMessageId').lean();
 await reconcileHistoricalCustomerLinks();const linked=await Conversation.findById(history._id);assert.equal(linked.customerId,'matter:1');assert.equal(linked.sourceMetadata.historySourceIdentity,undefined);assert.equal(linked.sourceMetadata.historySourceIdentityState,'verified_same_customer');assert.equal(linked.sourceMetadata.historySourceIdentities.length,2);assert.equal(linked.sourceRevision,history.sourceRevision);assert.equal(JSON.stringify(await Review.findById(review._id).lean()),reviewBefore);assert.deepEqual(await Message.find({conversationId:history._id}).select('text type sentAt externalMessageId').lean(),originalMessages);
 assert.equal(await Message.countDocuments({source:'gallabox_history',conversationId:history._id,'sourceMetadata.nativeIdentity.method':'export_account_and_native_message_id'}),2);
});
test('directory replacement between identity read and write is fenced before linking',{skip:!enabled},async()=>{
 const contact=await Contact.create({scope:'directory-race',externalContactId:'contact',phone:'971501234567'});
 const conversation=await Conversation.create({source:'gallabox',scope:'directory-race',externalConversationId:'directory-race',sourceMetadata:{externalContactId:'contact'}});
 const original=DirectoryState.updateOne;let injected=false;
 DirectoryState.updateOne=function(filter,update,options){if(!options?.session||injected)return original.call(this,filter,update,options);injected=true;return(async()=>{await DirectoryState.collection.updateOne({key:'matter_customer_directory'},{$set:{activeGeneration:'replacement'}});return original.call(this,filter,update,options);})();};
 try{await reconcileServiceCustomerLinks();assert.equal(injected,true);assert.equal((await Conversation.findById(conversation._id)).customerId,null);}finally{DirectoryState.updateOne=original;await DirectoryState.updateOne({key:'matter_customer_directory'},{$set:{activeGeneration:'fixture'}});}
});
test('history source contact is mapped independently of an unresolved Matter customer',{skip:!enabled},async()=>{
 const scope=`${account}:source-only`;const native=await Conversation.create({source:'gallabox',scope,externalConversationId:'source-only',sourceMetadata:{externalContactId:'source-only-contact'}});
 const history=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:'source-only-history',sourceRevision:3});
 const base={externalMessageId:'source-only-message',sentAt:new Date(),type:'text',text:'Fixture',sourceMetadata:historyProvenance};await Message.create([{...base,source:'gallabox',scope,conversationId:native._id},{...base,source:'gallabox_history',scope:'book',conversationId:history._id}]);
 await reconcileHistoricalCustomerLinks();const saved=await Conversation.findById(history._id);assert.equal(saved.customerId,null);assert.equal(saved.sourceMetadata.historySourceIdentity.externalContactId,'source-only-contact');assert.equal(saved.sourceRevision,3);
});
test('new ambiguous native evidence invalidates old source attestations without changing saved customer', {skip:!enabled},async()=>{
 const history=await Conversation.findOne({source:'gallabox_history',externalConversationId:'h'}),message=await Message.findOne({source:'gallabox_history',conversationId:history._id});assert.ok(history.sourceMetadata.historySourceIdentity);assert.ok(message.sourceMetadata.nativeIdentity);
 const native=await Conversation.create({source:'gallabox',scope:`${account}:ambiguous`,externalConversationId:'duplicate-native',sourceMetadata:{externalContactId:'different'}});
 await Message.create({source:'gallabox',scope:native.scope,conversationId:native._id,externalMessageId:message.externalMessageId,sentAt:message.sentAt,type:message.type,text:message.text});
 await reconcileHistoricalCustomerLinks();const after=await Conversation.findById(history._id),afterMessage=await Message.findById(message._id);assert.equal(after.sourceMetadata.historySourceIdentity,undefined);assert.equal(afterMessage.sourceMetadata.nativeIdentity,undefined);assert.equal(after.customerId,history.customerId);assert.equal(after.sourceRevision,history.sourceRevision);
});
test('explicit multiple contact values suspend old matches without transferring identity',{skip:!enabled},async()=>{
 const scope='multiple-contact-values';await Contact.create({scope,externalContactId:'contact',phone:'971501234567',customerId:'matter:1',matchState:'matched',origin:'gallabox_api'});
 await observeServiceContacts({scope,contacts:[{externalContactId:'contact',multiplePhones:true,multipleEmails:false}]});let saved=await Contact.findOne({scope});assert.equal(saved.matchState,'pending');assert.equal(saved.phone,'971501234567');await reconcileServiceCustomerLinks();saved=await Contact.findOne({scope});assert.equal(saved.matchState,'ambiguous');assert.equal(saved.customerId,'matter:1');
 await observeServiceContacts({scope,contacts:[{externalContactId:'contact',phone:'971501234567',multiplePhones:false}]});await reconcileServiceCustomerLinks();assert.equal((await Contact.findOne({scope})).matchState,'matched');
});

test('reviewed customer email resolves a shared phone and retains its source evidence after reload',{skip:!enabled},async()=>{
 const scope='reviewed-email';const phone='971509876543';
 await Customer.create([{customerId:'matter:email-a',email:'email-a@fixture.invalid',phone,source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'},{customerId:'matter:email-b',email:'email-b@fixture.invalid',phone,source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'}]);
 const c=await Contact.create({scope,externalContactId:'email-contact',phone});
 await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(c._id)).matchState,'ambiguous');
 const evidence={source:'gallabox_customer_message',externalMessageId:'email-proof',sentAt:'2026-08-25T05:06:23.000Z',email:'email-a@fixture.invalid'};
 await Contact.updateOne({_id:c._id},{$set:{email:evidence.email,emailEvidence:evidence}});
 await reconcileServiceCustomerLinks();const saved=await Contact.findById(c._id).lean();assert.equal(saved.customerId,'matter:email-a');assert.equal(saved.matchedBy,'exact_email_and_phone');assert.deepEqual(saved.emailEvidence,evidence);
});
async function multiContactFixture(label,{differentOwner=false,missing=false}={}){
 const scope=`${account}:${label}`;const contacts=await Contact.create(['a','b'].map((id,i)=>({scope,externalContactId:`${label}-${id}`,customerId:differentOwner&&i?'matter:2':'matter:1',matchState:'matched'})));
 const natives=await Conversation.create(contacts.map(c=>({source:'gallabox',scope,externalConversationId:c.externalContactId,customerId:c.customerId,sourceMetadata:{externalContactId:c.externalContactId}})));
 const history=await Conversation.create({source:'gallabox_history',scope:'book',externalConversationId:label});
 for(let i=0;i<2;i++){const base={externalMessageId:`${label}-message-${i}`,sentAt:new Date(),text:'Fixture',type:'text',sourceMetadata:historyProvenance};await Message.create({...base,source:'gallabox_history',scope:'book',conversationId:history._id});if(!missing||i===0)await Message.create({...base,source:'gallabox',scope,conversationId:natives[i]._id});}
 return{contacts,history};
}
test('different verified owners and missing exact native identities remain unresolved',{skip:!enabled},async()=>{
 for(const [label,options] of [['different-owners',{differentOwner:true}],['missing-multi',{missing:true}]]){const {history}=await multiContactFixture(label,options);await reconcileHistoricalCustomerLinks();const saved=await Conversation.findById(history._id);assert.equal(saved.customerId,null);assert.equal(saved.sourceMetadata.historySourceIdentities,undefined);assert.equal(saved.sourceMetadata.historySourceIdentityState,options.missing?'incomplete':'mixed_contacts');}
});
test('changed member contact prevents publishing a same-customer multi-contact attestation',{skip:!enabled},async()=>{
 const {contacts,history}=await multiContactFixture('multi-race');const original=Contact.updateOne;let injected=false;
 Contact.updateOne=function(filter,update,options){if(String(filter._id)!==String(contacts[1]._id)||!options?.session||injected)return original.call(this,filter,update,options);injected=true;return(async()=>{await Contact.collection.updateOne({_id:contacts[1]._id},{$set:{matchState:'conflict',updatedAt:new Date(Date.now()+1000)}});return original.call(this,filter,update,options);})();};
 try{await reconcileHistoricalCustomerLinks();}finally{Contact.updateOne=original;}
 const saved=await Conversation.findById(history._id);assert.equal(injected,true);assert.equal(saved.customerId,null);assert.equal(saved.sourceMetadata.historySourceIdentities,undefined);assert.notEqual(saved.sourceMetadata.historySourceIdentityState,'verified_same_customer');
});

test('reviewed self-phone survives reload and observation but invalidates changed source, collision and revocation',{skip:!enabled},async()=>{
 const {reviewedPhoneMessageHash}=await import('../services/customerServiceIdentity.js');
 const phone='971507777771',nativePhone='971507777772',scope='reviewed-self-phone';
 await Customer.create({customerId:'matter:self-proof',phone,name:'Self proof',source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'});
 const contact=await Contact.create({scope,externalContactId:'self-contact',phone:nativePhone,origin:'gallabox_api'});
 const conversation=await Conversation.create({source:'gallabox',scope,externalConversationId:'self-conversation',sourceMetadata:{externalContactId:contact.externalContactId}});
 const message=await Message.create({source:'gallabox',scope,externalMessageId:'self-message',conversationId:conversation._id,externalAuthorId:contact.externalContactId,authorType:'customer',internalNote:false,type:'text',text:`You can call me at ${phone}`,sentAt:new Date('2026-09-03T00:00:00Z'),sourceMetadata:{externalContactId:contact.externalContactId}});
 const original=message.toObject();const proof={state:'reviewed',method:'explicit_customer_self_phone',scope,externalContactId:contact.externalContactId,messageId:String(message._id),externalMessageId:message.externalMessageId,conversationId:String(conversation._id),messageSha256:reviewedPhoneMessageHash(original),phone,customerId:'matter:self-proof',originalContactPhone:nativePhone,originalContactEmail:'',reviewedAt:new Date().toISOString()};
 await Contact.updateOne({_id:contact._id},{$set:{reviewedPhoneProof:proof}});
 await reconcileServiceCustomerLinks();let saved=await Contact.findById(contact._id).lean();assert.equal(saved.matchState,'matched');assert.equal(saved.matchedBy,'reviewed_customer_self_phone');assert.equal(saved.phone,nativePhone);assert.deepEqual(saved.reviewedPhoneProof,proof);assert.equal((await Conversation.findById(conversation._id)).customerId,'matter:self-proof');
 const afterMessage=await Message.findById(message._id).lean();for(const key of ['text','sentAt','updatedAt','externalAuthorId'])assert.deepEqual(afterMessage[key],original[key]);
 await observeServiceContacts({scope,contacts:[{externalContactId:contact.externalContactId,phone:nativePhone}]});await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(contact._id)).matchState,'matched');
 await Message.updateOne({_id:message._id},{$set:{text:'Changed source declaration'}});await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(contact._id)).matchState,'conflict');
 await Message.updateOne({_id:message._id},{$set:{text:original.text}});await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(contact._id)).matchState,'matched');
 const collision=await Customer.create({customerId:'matter:self-collision',phone,source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'});await reconcileServiceCustomerLinks();assert.notEqual((await Contact.findById(contact._id)).matchState,'matched');await Customer.updateOne({_id:collision._id},{$set:{active:false}});
 await Contact.updateOne({_id:contact._id},{$set:{'reviewedPhoneProof.revokedAt':new Date().toISOString()}});await reconcileServiceCustomerLinks();saved=await Contact.findById(contact._id).lean();assert.notEqual(saved.matchState,'matched');assert.equal(saved.phone,nativePhone);assert.equal(saved.customerId,'matter:self-proof');
});

test('reviewed sender proof links only listed conversations, never future captures, and invalidates on additions',{skip:!enabled},async()=>{
 const {nativeSenderConversationHash}=await import('../services/customerServiceIdentity.js');const {ingestServiceBatch}=await import('../services/customerServiceCapture.js');
 const scope=`${account}:sender-channel`,phone='971507654321',customerId='matter:sender-proof',externalContactId='sender-contact';
 await Customer.create({customerId,name:'Sender fixture',phone,source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'});
 const contact=await Contact.create({scope,externalContactId,phone,multiplePhones:true});const [c,unlisted]=await Conversation.create([{source:'gallabox',scope,externalConversationId:'proven-thread',sourceMetadata:{externalContactId}},{source:'gallabox',scope,externalConversationId:'unlisted-thread',sourceMetadata:{externalContactId}}]);
 const m=await Message.create({source:'gallabox',scope,externalMessageId:'sender-proof-message',conversationId:c._id,externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date(),type:'text',text:'Fixture',sourceMetadata:{externalContactId,verifiedCustomerEndpoint:{phone,accountId:account,channelId:'sender-channel',contactId:externalContactId,sender:externalContactId,externalMessageId:'sender-proof-message',externalConversationId:c.externalConversationId,direction:'inbound',sourceSha256:'a'.repeat(64)}}});
 await Contact.updateOne({_id:contact._id},{$set:{reviewedNativeSenderProof:{state:'reviewed',method:'native_customer_phone_endpoint',reviewedAt:new Date().toISOString(),scope,externalContactId,originalContactPhone:phone,originalContactEmail:'',originalMultiplePhones:true,originalMultipleEmails:false,phone,customerId,conversations:[{conversationId:String(c._id),messageCount:1,messageSha256:nativeSenderConversationHash([m.toObject()])}]}}});
 await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(contact._id)).matchState,'reviewed_scoped');assert.equal((await Conversation.findById(c._id)).customerId,customerId);assert.ok(!(await Conversation.findById(unlisted._id)).customerId);
 const historical=await Conversation.create({source:'gallabox_history',scope:'sender-book',externalConversationId:'proven-historical',sourceRevision:1});await Message.create({source:'gallabox_history',scope:'sender-book',externalMessageId:m.externalMessageId,conversationId:historical._id,sentAt:m.sentAt,type:'text',text:m.text,sourceMetadata:historyProvenance});await reconcileHistoricalCustomerLinks();assert.equal((await Conversation.findById(historical._id)).customerId,customerId);
 await ingestServiceBatch({source:'gallabox',scope,requestId:'sender-future-capture',messages:[{externalMessageId:'future-message',externalConversationId:'future-thread',externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date().toISOString(),type:'text',text:'New fixture',sourceMetadata:{externalContactId}}]});
 assert.ok(!(await Conversation.findOne({scope,externalConversationId:'future-thread'})).customerId);
 await Message.create({source:'gallabox',scope,externalMessageId:'new-unreviewed-message',conversationId:c._id,externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date(),text:'New source',sourceMetadata:{externalContactId}});await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(contact._id)).matchState,'ambiguous');
});

test('account screenshot proof survives reload but never covers partial history or future captures',{skip:!enabled},async()=>{
 const {createHash}=await import('node:crypto');const {nativeSenderConversationHash,reviewedPhoneMessageHash,readValidatedNativeSenderProof}=await import('../services/customerServiceIdentity.js');const {ingestServiceBatch}=await import('../services/customerServiceCapture.js');
 const scope=`${account}:account-screenshot`,phone='971507654399',email='screenshot@fixture.invalid',customerId='matter:screenshot',externalContactId='screenshot-contact',url='https://media.fixture.invalid/selection.jpg',urlHash=createHash('sha256').update(url).digest('hex');
 await Customer.create([{customerId,name:'Screenshot fixture',email,phone,source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'},{customerId:'matter:screenshot-other',name:'Other fixture',phone,email:'other-screenshot@fixture.invalid',source:'fixture',sourceObservedAt:new Date(),sourceCoverage:'fixture',active:true,generation:'fixture'}]);
 const contact=await Contact.create({scope,externalContactId,phone});const [c,unlisted]=await Conversation.create([{source:'gallabox',scope,externalConversationId:'screenshot-thread',sourceMetadata:{externalContactId}},{source:'gallabox',scope,externalConversationId:'unlisted-screenshot-thread',sourceMetadata:{externalContactId}}]);
 const m=await Message.create({source:'gallabox',scope,externalMessageId:'screenshot-proof-message',conversationId:c._id,externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date(),type:'image',sourceMetadata:{externalContactId,media:{url,mimeType:'image/jpeg'},reviewedAccountSource:{accountId:account,channelId:'account-screenshot',contactId:externalContactId,sender:externalContactId,externalMessageId:'screenshot-proof-message',externalConversationId:c.externalConversationId,sourceSha256:'a'.repeat(64),mediaUrlSha256:urlHash,mediaSha256:'b'.repeat(64)}}});
 const proof={state:'reviewed',method:'account_email_screenshot',reviewedAt:new Date().toISOString(),reviewedBy:'fixture-reviewer',scope,externalContactId,originalContactPhone:phone,originalContactEmail:'',originalMultiplePhones:false,originalMultipleEmails:false,email,customerId,conversations:[{conversationId:String(c._id),messageCount:1,messageSha256:nativeSenderConversationHash([m.toObject()]),screenshot:{messageId:String(m._id),externalMessageId:m.externalMessageId,messageSha256:reviewedPhoneMessageHash(m.toObject()),sourceSha256:'a'.repeat(64),mediaSha256:'b'.repeat(64),mediaUrlSha256:urlHash,reviewKind:'successful_account_selection'}}]};
 await Contact.updateOne({_id:contact._id},{$set:{reviewedNativeSenderProof:proof}});await reconcileServiceCustomerLinks();let saved=await Contact.findById(contact._id).lean();assert.equal(saved.matchState,'reviewed_scoped');assert.equal((await readValidatedNativeSenderProof(saved)).customerId,customerId);assert.deepEqual(new Set(saved.candidateCustomerIds),new Set([customerId,'matter:screenshot-other']));assert.ok(!(await Conversation.findById(unlisted._id)).customerId);
 const [complete,partial]=await Conversation.create(['complete-screenshot-history','partial-screenshot-history'].map(externalConversationId=>({source:'gallabox_history',scope:'screenshot-book',externalConversationId})));
 for(const h of [complete,partial])await Message.create({source:'gallabox_history',scope:'screenshot-book-'+String(h._id),externalMessageId:m.externalMessageId,conversationId:h._id,sentAt:m.sentAt,type:'image',sourceMetadata:historyProvenance});
 await Message.create({source:'gallabox_history',scope:'screenshot-book',externalMessageId:'unproven-history-message',conversationId:partial._id,sentAt:new Date(),text:'Unproven',sourceMetadata:historyProvenance});await reconcileHistoricalCustomerLinks();assert.equal((await Conversation.findById(complete._id)).customerId,customerId);assert.ok(!(await Conversation.findById(partial._id)).customerId);
 await ingestServiceBatch({source:'gallabox',scope,requestId:'screenshot-future',messages:[{externalMessageId:'screenshot-future-message',externalConversationId:'screenshot-future-thread',externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date().toISOString(),type:'text',text:'Future',sourceMetadata:{externalContactId}}]});assert.ok(!(await Conversation.findOne({scope,externalConversationId:'screenshot-future-thread'})).customerId);
 await Contact.updateOne({_id:contact._id},{$set:{'reviewedNativeSenderProof.revokedAt':new Date().toISOString()}});await reconcileServiceCustomerLinks();saved=await Contact.findById(contact._id).lean();assert.equal(saved.matchState,'ambiguous');assert.equal(await readValidatedNativeSenderProof(saved),null);
 await Contact.updateOne({_id:contact._id},{$set:{reviewedNativeSenderProof:proof}});await reconcileServiceCustomerLinks();assert.ok(await readValidatedNativeSenderProof(await Contact.findById(contact._id).lean()));
 await Message.create({source:'gallabox',scope,externalMessageId:'new-screenshot-thread-message',conversationId:c._id,externalAuthorId:externalContactId,authorType:'customer',sentAt:new Date(),text:'New message',sourceMetadata:{externalContactId}});await reconcileServiceCustomerLinks();assert.equal((await Contact.findById(contact._id)).matchState,'ambiguous');
});
