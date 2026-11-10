# Understand GPS evidence in a delivery report

This page explains how the source service compares a delivery photo time with recorded vehicle positions. It helps reviewers interpret the result and helps maintainers preserve the rules when changing collection or reporting code.

The GPS method is `gps-observations-v2`. It applies to the fallback used when no matching Truckoom geofence alerts are available. Actual geofence alerts keep their separate evaluation path. Neither source establishes customer handover by itself.

## Keep the clocks separate

Each clock answers a different question:

| Clock | Question it answers | Limitation |
|---|---|---|
| GPS time | When did the tracker measure this position? | A missing or invalid GPS time cannot establish a timed position. |
| Collection time | When did the service save this observation? | The service may collect the same older position again. Collection time does not replace GPS time. |
| Photo capture time | When does the device say it took the photo? | This is device-reported evidence. A camera source label does not independently authenticate the clock. |
| Photo receipt time | When did the server receive the photo? | An offline upload may arrive later. Receipt time does not establish capture or delivery time. |

Normalized clock strings used by the evaluator require explicit time zones. Raw vendor live/history timestamps use their separate UAE wall-clock format, which the source adapter converts first. Stored date values remain UTC instants; the application displays Dubai time. The saved-history query selects observations by collection time, so a returned position can have an earlier GPS date.

## Interpret repeated positions

A collection can succeed while returning an older GPS fix. The method combines observations with the same GPS time and exact coordinates when evaluating a position. Later collection receipts do not extend that fix to a later time.

An unchanged position with a new GPS time is a new observation. An unchanged position with the same GPS time is repeated evidence of one older measurement. Repetition alone does not prove the tracker was stopped or that the vehicle remained there between collections.

## Check whether a position is usable

The method checks the original GPS clock and coordinates before comparing them with a destination:

- Missing, malformed or timezone-less clocks remain untimed. The method does not substitute collection time.
- A fix later than its original source-response receipt or evaluation cutoff is excluded from timed support. Reading a cache or sampling it again later does not repair that clock conflict. Historical cache rows without an original receipt remain uncertain until a fresh response supplies one.
- Invalid coordinates and contradictory positions at the same GPS time interrupt support.
- An explicitly ambiguous driver mapping remains uncertain. Same-vehicle observations with missing or different driver mappings interrupt support instead of disappearing between matching observations.
- A movement over 500 metres with an implied speed above 180 km/h taints both endpoints. Repeated fixes at that jump destination remain tainted until a usable position changes. An intervening invalid, conflicting, future-clock or assignment-uncertain observation does not clear that taint.
- A gap longer than five minutes separates observation segments. An outside position after the gap cannot close an earlier sampled entry.

The distance, speed and gap values are conservative screening parameters, not guarantees of tracker accuracy or continuous presence. A configured customer radius must be positive and finite. Existing saved customer radii are preserved; the application default is 60 metres.

An untimed observation in the considered vehicle/driver scope makes the GPS photo comparison uncertain because it cannot safely be placed before or after the photo. Raw evidence remains available for investigation.

## Read the result

The server retains the existing result names so the report and its layout remain compatible:

| Result | Plain-language meaning |
|---|---|
| `gps_visit_observed` | A usable fix at the photo time is inside the saved radius, or usable inside fixes bracket the photo within one observation segment. This is an estimated GPS comparison. |
| `gps_window_review` | A usable fix at exactly the photo time is outside the saved radius. This warrants review; it does not prove a missed delivery. |
| `incomplete_events` | The available GPS cannot support the comparison, for example because the photo falls in a gap, the clock is missing, or readings conflict. |
| `awaiting_events` | No GPS observations are available for the comparison, or the photo falls outside the selected business-day window. |
| `missing_photo_time` | A usable camera capture time/source is unavailable. |
| `uploaded_photo` | The photo was supplied as an upload; its original capture time remains unverified. |

For a supported comparison, the displayed arrival is the first usable inside observation in the selected consecutive run. The departure is the next usable outside observation in that segment, if one exists. These are approximate observation boundaries, not independently confirmed arrival, departure or continuous dwell times. `visitCount` for the GPS method describes the selected supported run; it is not a complete count of physical visits.

A photo between two outside observations is not automatically marked outside. The vehicle might have moved between those observations. The method also does not extend a last-known inside position forward to a later photo.

Gallery-upload and missing-camera-time behavior remain separate from GPS quality. Actual geofence entry/exit events retain their existing status rules. GPS results never change a delivery's completion status by themselves.

## Preserve the previous result

When the sync first replaces a legacy GPS assessment, it saves that assessment once in the server-owned `trackerVisitGpsBaseline` field. The replacement records `trackerVisit.gpsMethod` and `trackerVisit.gpsQualityReasons`.

The baseline and replacement are saved together under the existing delivery-version check. The baseline remains outside `trackerVisit` so proof reassignment or invalidation can reset the active visit without deleting it. Delivery requests cannot set or replace these server-owned evidence fields.

This is one retained pre-migration assessment, not a complete audit of every historical refresh. No bulk retrospective rewrite is included. The normal sync may reevaluate eligible deliveries, and any assessment changes must retain that baseline and be checked during release qualification.

## Verify changes to this method

Maintain fixtures that exercise the complete saved-observation-to-delivery-result path. Cover missing clocks, long gaps, repeated receipts, same-time position conflicts, impossible jumps, future clocks, ambiguous mappings, mixed cached and sampled fixes, proof invalidation and preservation of the previous result.

Keep true geofence-alert fixtures and the existing tracker-card tests passing. They protect separate behavior that a GPS fallback change must not alter. Before deployment, qualify actual database persistence and the reviewer journey in the approved environment; fixture results do not establish production or field behavior.

Implementation references:

- [GPS observation evaluator](../server/services/trackerGpsVisits.js)
- [Delivery tracker synchronization](../server/services/truckoomVisitSync.js)
- [Separate geofence and photo rules](../server/services/truckoomVisitRules.js)
- [Delivery evidence fields](../server/models/Delivery.js)
- [GPS comparison tests](../server/services/trackerGpsVisits.test.js)
- [Synchronization tests](../server/services/truckoomVisitSync.test.js)
- [Server-owned evidence protection tests](../server/routes/trackerEvidence.test.js)
