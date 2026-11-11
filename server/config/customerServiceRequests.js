// Explicit request taxonomy. Legacy categoryIds remain unchanged for provenance.
export const REQUEST_TOPICS = Object.freeze([
 ['renewal','Renewal','Subscription'],['plan_change','Plan Change / Upgrade','Subscription'],['pause','Skip / Pause','Subscription'],['refund','Cancellation / Refund','Subscription'],
 ['meal_selection','Meal Selection','Ordering'],['delivery_missed','Delivery – Late / Missed','Delivery'],['delivery_instructions','Delivery – Address / Instructions','Delivery'],['bag_collection','Bag Collection','Delivery'],
 ['food_quality','Food Quality / Hygiene','Product'],['exclusions','Exclusions / Customisation','Product'],['nutrition','Nutrition / Macros Info','Product'],
 ['discount','Discount / Partner Code','Sales'],['new_lead','New Lead / Plan Enquiry','Sales'],['returning_lead','Returning Customer Lead','Sales'],['billing','Billing / Payment','Finance'],['feedback','Feedback / Feature Request','Other'],['other','Other','Other']
].map(([id,label,group])=>Object.freeze({id,label,group})));
export const REQUEST_RULES = Object.freeze(['assignment_overdue','response_overdue','followup_overdue','resolution_incomplete','policy_exception']);
export const REQUEST_PERMISSIONS = Object.freeze(['assignRequests','approveExceptions','closeSensitive','managePolicies','reportingAccess']);
