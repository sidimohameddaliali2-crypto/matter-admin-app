// Exact staff Topic / Includes taxonomy. These tags do not rewrite legacy
// classification: each reason selects an existing, trusted action family.
const include=(id,label,workflowTopic)=>Object.freeze({id,label,workflowTopic});
const tag=(id,label,group,includes)=>Object.freeze({id,label,group,includes:Object.freeze(includes)});

export const REQUEST_TOPIC_TAGS=Object.freeze([
 tag('tag_delivery','Delivery Issues','Delivery',[
  include('late_delivery','Late Delivery','delivery_missed'),
  include('missed_delivery','Missed Delivery','delivery_missed'),
  include('early_delivery','Early Delivery','delivery_missed'),
  include('wrong_address','Wrong Address','delivery_instructions'),
  include('instructions_not_followed','Instructions Not Followed','delivery_instructions'),
  include('tracking_issue','Tracking Issue','delivery_missed'),
  include('temperature','Temperature','food_quality'),
 ]),
 tag('tag_bags','Bags & Collections','Delivery',[
  include('missed_collection','Missed Collection','bag_collection'),
  include('delayed_collection','Delayed Collection','bag_collection'),
  include('bag_return_deposit','Bag Return / Deposit','bag_collection'),
  include('bag_not_collected','Bag Not Collected','bag_collection'),
 ]),
 tag('tag_meal_accuracy','Meal Accuracy','Ordering',[
  include('wrong_meal','Wrong Meal','meal_selection'),
  include('missing_item','Missing Item','meal_selection'),
  include('exclusion_not_followed','Exclusion Not Followed','meal_selection'),
  include('incorrect_macros','Incorrect Macros','meal_selection'),
  include('incorrect_portion','Incorrect Portion','meal_selection'),
 ]),
 tag('tag_damage','Damaged Food & Packaging','Product',[
  include('leaking_packaging','Leaking Packaging','food_quality'),
  include('damaged_containers','Damaged Containers','food_quality'),
  include('food_spillage','Food Spillage','food_quality'),
  include('damaged_bag','Damaged Bag','food_quality'),
 ]),
 tag('tag_food_quality','Food Quality','Product',[
  include('taste_flavor','Taste / Flavor','food_quality'),
  include('freshness','Freshness','food_quality'),
  include('food_consistency','Food Consistency','food_quality'),
 ]),
 tag('tag_food_safety','Food Safety & Allergies','Product',[
  include('allergy_concern_reaction','Allergy Concern / Reaction','food_quality'),
  include('suspected_spoilage','Suspected Spoilage','food_quality'),
  include('foreign_object','Foreign Object - (Plastic, Metal, Hair, etc.)','food_quality'),
  include('food_contamination','Food Contamination','food_quality'),
  include('food_safety_concern','Food Safety Concern','food_quality'),
 ]),
 tag('tag_plan','Plan & Subscription','Subscription',[
  include('plan_renewal','Plan Renewal','renewal'),
  include('plan_change','Plan Change','plan_change'),
  include('subscription_pause','Subscription Pause','pause'),
  include('cancellation','Cancellation','refund'),
  include('billing_issue','Billing Issue','billing'),
  include('dietary_preferences_exclusions','Dietary Preferences / Exclusions','exclusions'),
 ]),
 tag('tag_menu','Menu & Meal Selection','Ordering',[
  include('meal_selection','Meal Selection','meal_selection'),
  include('menu_variety','Menu Variety','feedback'),
  include('inaccurate_description','Inaccurate Description','menu_support'),
  include('photos','Photos','menu_support'),
 ]),
 tag('tag_payments','Payments & Refunds','Finance',[
  include('payment_failure','Payment Failure','billing'),
  include('duplicate_charge','Duplicate Charge','billing'),
  include('incorrect_charge','Incorrect Charge','billing'),
  include('payment_method_issue','Payment Method Issue','billing'),
  include('refund_status','Refund Status','refund'),
  include('refund_not_received','Refund Not Received','refund'),
  include('auto_recurring_payment','Auto/Recurring Payment','billing'),
 ]),
 tag('tag_account','Website & Account','Account',[
  include('login_issue','Login Issue','account_support'),
  include('account_access','Account Access','account_support'),
  include('website_issue','Website Issue','account_support'),
  include('app_issue','App Issue','account_support'),
  include('account_information_update','Account Information Update','account_support'),
 ]),
]);

// This list intentionally contains only the previous 17 stored topic IDs.
// Newly added internal action families are not accepted as legacy Topic tags.
const legacyTopics=new Set(['renewal','plan_change','pause','refund','meal_selection','delivery_missed','delivery_instructions','bag_collection','food_quality','exclusions','nutrition','discount','new_lead','returning_lead','billing','feedback','other']);
const byTopic=new Map(REQUEST_TOPIC_TAGS.map(topic=>[topic.id,new Map(topic.includes.map(reason=>[reason.id,reason.workflowTopic]))]));
const fail=message=>{throw Object.assign(new Error(message),{statusCode:400});};

export function requestWorkflowTopic(classification){
 if(!classification||['spam','vendor','non_customer'].includes(classification.kind))return null;
 const topic=classification.topic;
 if(topic===undefined||topic===null||topic==='')return null;
 if(legacyTopics.has(topic))return topic;
 const reasons=byTopic.get(topic);
 if(!reasons)fail('Choose a known Topic tag.');
 const workflowTopic=reasons.get(classification.subtopic);
 if(!workflowTopic)fail('Choose an Includes reason belonging to this Topic tag.');
 return workflowTopic;
}
