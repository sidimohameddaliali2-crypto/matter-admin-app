# Unsaved custom-control history

The staff, partner and member web app records a custom choice when the person changes it, even if they close the screen or never save. The server identifies the signed-in account. The browser supplies the observed field, previous value and next value; it cannot declare a saved business change or choose an actor.

An unsaved choice appears as **Not saved**. A submitted request and a confirmed database change remain separate evidence. A failed write does not erase the earlier choice. Actual database effects are still confirmed by their owning storage path.

## Current mounted controls

| Area | User changes reported before Save | Owning components/pages |
| --- | --- | --- |
| Deliveries and dispatch | Selected deliveries, group/map/polygon/circle choices, pins, clear/reset, custom filters, manual stop ordering, route hubs and simulation choices | `Deliveries`, `DispatcherDesktop`, `DispatcherMobile`, `DispatcherMapAssignModal`, `LocationPinPicker`, `ManualOrderModal`, `DeliveryOrderModal`, `DriverRouteMap2GIS`, `RouteOptimizationModal` |
| Delivery forms | Customer choices, entry method and dependent delivery type, current customer lookup defaults, address-category/link/coordinate dependencies, task/bag rows, DayPicker dates, date chips, import file replacement and discarded rows | `AddDelivery`, `AddDeliveryChange`, `DeliveryAddressFields` |
| Driver and warehouse | Live bag scan/manual add/remove/clear/discard, return choices, photos selected/retaken/discarded, warehouse condition reasons and count/registration changes, driver view/history filters | `DriverMobile`, `BagOperations` |
| Customer Service | Request type/topic/detail, action/intent/outcome, owner-dependent status, quick dates, conditional defaults and clears, classification suggestions, evidence removal, draft discard and restored values | `RequestActionForm`, `RequestWork`, `ActionEditor`, `ReviewPanel`, `CustomerLinkReview`, `MetricsCalendarSettings`, `IssueDetailPicker` |
| Customer Service views | Customer/conversation/issue/message/follow-up choices, queues, date shortcuts, tabs, filters, drilldowns, pagination and practice-topic detail defaults | `CustomerService`, `CustomerChats`, `Customers`, `Problems`, `Summary`, `CustomerContext`, `RequestReport`, `SidebarSandbox` |
| Dashboard communications | Customer choice/clear, priority, photo removal, reset/dismissal, issue filtering and selection | `ReportIssueForm`, `QuickReportForm`, `QuickNewCommunicationModal`, `ResolveModal`, `DeliveryIssuesTab` |
| Customers and subscriptions | Pause/return calendar choices, meal-preference partner defaults and restored edits, dietary changes, renewal/complaint/delivery-change custom filter and bulk choices | `WebsiteSubscription`, `MealPreferences`, `MemberExclusionPicker`, `Renewal`, `Complaints`, `DeliveryChanges` |
| Menus | Ingredients and visibility, recipes, exclusions, composition, allergens, meal replacement/removal, cycle placement/drop/remove/duplicate/copy | `IngredientTagEditor`, `SupyRecipeSearch`, `ComponentExclusions`, `WorkbookMealPages`, `WeeklyCycleBoard`, `MenuManagement` |
| Kitchen | Meal-option add/remove, snack preset choices, cleared draft input, customer-status filters and counting date chips | `KitchenList`, `KitchenCounting` |
| Partner/member ordering | Calendar/date, delivery window, item quantities, existing-order edits/discard, member profile restoration, order-view filters | `PartnerOrderCalendar`, `PartnerDailyOrderPlanner`, `PartnerPortal`, `MemberPortal` |
| Events and administration | Staff/equipment/food/asset rows, venue/option choices, role-dependent permission defaults and partner image removal | `CreateEventModal`, `EventDetailModal`, `UserPermissionsModal`, `AdminPartners` |
| Labels and print | Style/color/mode choices, bulk inclusion/selection/area choices, reset and logo removal | `StickerDesignerModal`, `PrintConfigModal`, `BagTagPrintModal` |

This map refers to mounted paths inspected in the November 17 change. Native selects, checkboxes, text/date fields and editable text retain the shared native capture. Their custom dependent changes are observed separately, rather than duplicating the same native field event. Unused legacy widgets are not counted as live coverage.

## Implementation contract

Use `recordActivityChange({ field, before, after, form, element, private })` from `client/src/utils/activityCapture.js` in the actual user-change handler. Supply readable scalar values or arrays of readable values. Give a repeated row, route, meal, day or record enough context to distinguish it. Do not pass whole domain objects, actor claims, file objects or credentials.

Use `activityReference(label, id)` for existing entities. A display name is not an identity: two same-named customers, drivers, meals, recipes or components can still be different records. Entity-specific quantity/timing and native Core labels retain their record context too. Native selects add option values when displayed labels are ambiguous. Machine references stay in the retained event and Details; the first draft sentence keeps the name readable.

- Record all accepted changes, including returning to the original value. A no-op selection is not another change.
- Record dependent defaults, clears and restored edits at the same user boundary. Never record from render, a React state-updater function, polling, mounting or draft recovery.
- For asynchronous lookup/device callbacks, preserve the initiating account/page/selection and discard obsolete results. Do not attribute another session's callback to the current account.
- End map gestures and remove their listeners when the owning marker or screen is destroyed. Keep delivery record IDs alongside bounded readable labels: two deliveries for one customer are different choices.
- Keep native events once. Use `data-activity-label` where an existing native field needs a precise history label; private ancestors/fields retain masking.
- Photos record counts, never filenames, data URLs or object URLs. Sensitive notes, medical choices, references and protected data are masked before queuing and again by the server.
- Import discard/replacement records total row counts, source row numbers and bounded references, without filenames or imported record bodies. A completed import's automatic cleanup is not another human discard.
- Long changed lists/text retain a bounded excerpt around the first difference. They must not disappear just because an unchanged prefix filled the excerpt.
- Keep capture separate from business behavior. Its return value must not determine whether the application accepts or saves the person's choice.

The existing account-isolated offline queue, failure indicators, retry IDs and private journal are reused. The exact-account reader guard is unchanged. New controls must satisfy this contract and include a real control-to-capture regression; registration alone is not evidence of coverage.

## Verification and boundaries

Fixture checks exercise real control handlers, serialization and the queue/network boundary. The focused cases cover no Save, keyboard and pointer choices, reversals, bulk/long-list edits, failed writes, deferred stale lookups, initial-load suppression, private values, account isolation and reload replay. The production release receipt separately records the final app version and authenticated browser check; fixture checks do not establish native-device or field acceptance.

Opening a disclosure, scrolling, loading and automatic GPS are not invented field edits. Automatic business writes retain their own server activity. Login and public token-link unsaved forms keep their existing credential boundary; anonymous people are never assigned a guessed staff identity. Edits in a separate application or native runtime require that runtime's own capture.
