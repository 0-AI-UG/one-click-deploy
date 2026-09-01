# OCD UI consistency audit

Audited: 2026-09-01

Scope: every route and shared component under `src/web/src`, across desktop and
mobile source paths. The audit covers visual hierarchy, spacing, terminology,
states, interactions, responsive behavior, and accessibility.

## Changes completed in this pass

- Added shared `PageShell`, `PageHeader`, `SectionHeader`, `PageState`, `Badge`,
  `InlineNotice`, and `AuthShell` primitives.
- Migrated the dashboard, environments, resources, app, stack, server, volume,
  operations, operation logs/detail, terminal, account, admin, user detail,
  login, setup, password reset, passkey, device-auth, and CLI-confirmation
  surfaces to the shared primitives where their layouts overlap.
- Standardized top-level loading, missing-resource, and error states.
- Made `Field` automatically associate labels with direct native controls.
- Replaced the simulated checkbox with a native keyboard- and screen-reader-
  accessible checkbox.
- Added dialog semantics, Escape handling, scroll locking, and live-region
  semantics for global confirmations and toasts.
- Added keyboard navigation and ARIA roles to tabs and the custom select.
- Normalized raw red/green/yellow utility colors to OCD design tokens.
- Fixed the mobile navigation's empty fourth column and the dashboard mobile
  filter's empty third column.
- Removed the stale hard-coded `v0.4` label from navigation.
- Standardized the user-facing labels “Environments” and “Operations” between
  desktop and mobile navigation.
- Made the CLI device-code entry fit narrow mobile screens and made the terminal
  height account for mobile browser chrome/navigation.

## Cross-cutting findings still to address

| Priority | Area | Problem | Proposed solution |
| --- | --- | --- | --- |
| P0 | CSS delivery | Tailwind and Google Fonts are loaded from CDNs at runtime. A blocked CDN, CSP, or offline panel can leave the product unstyled or with fallback typography. | Build Tailwind locally, pin it in `package.json`, emit a versioned CSS asset, and self-host the two font families or use a tested system-font stack. |
| P0 | Type scale | Much of the desktop UI uses 8–10 px text, then compensates with `html { zoom: 1.2 }`. Zoom changes layout geometry and makes breakpoint behavior harder to reason about. | Introduce named type tokens (`caption`, `label`, `body`, `title`), raise the minimum UI text size, then remove document zoom and verify at 100%, 125%, and 200% browser zoom. |
| P1 | Responsive architecture | Dashboard and app detail maintain separate mobile and desktop header/action trees. They already differ in wording, controls, and hierarchy. | Extract route view-models plus shared responsive `ResourceHeader`, `ActionGroup`, and `ResourceList` components; vary layout with CSS rather than duplicating behavior. |
| P1 | Buttons | Shared actions now use `Btn`, but file breadcrumbs, inline reconnect links, permission-scope controls, and a few icon controls still have one-off styles. | Add `IconButton`, `TextButton`, and `Breadcrumbs`; require an accessible label for icon-only actions. Migrate the remaining direct buttons. |
| P1 | Status semantics | Top-level status colors are centralized, while engine step rows, child operations, DNS, connection cards, and several admin states still choose presentation locally. | Add a single status-to-tone mapper and render all state through `StatusBadge`, `Badge`, or `InlineNotice`; reserve red for failures/destructive actions and amber for transitional/warning states. |
| P1 | Dialog focus | Confirmation dialogs and mobile sheets expose correct dialog semantics, but focus is not trapped and focus restoration is incomplete. The permission-scope modal has its own separate behavior. | Create one `Dialog`/`Sheet` abstraction with focus trap, initial focus, focus return, labelled title/description, backdrop handling, and scroll locking. |
| P1 | Validation | Many forms report validation only through transient toasts. The user cannot see which field is invalid after the toast disappears. | Add `FormField` error/help slots, `aria-invalid`, `aria-describedby`, and a persistent form-level summary. Keep toasts for request outcomes, not field validation. |
| P1 | Admin architecture | `admin/users.tsx` is an 800+ line settings hub with infrastructure, registry, source, workers, panel, OAuth, and users in one component. Visual drift follows ownership drift. | Split each admin section into a route-level component backed by shared `SettingsCard`, `ConnectionCard`, `DataList`, and `SectionHeader` primitives. |
| P1 | Tables | The shared `Table` becomes cards on mobile, but several admin/infrastructure tables still use raw table markup and therefore do not share responsive behavior. | Migrate raw tables to `Table` or a new `DataTable` that supports mobile labels, empty/loading rows, column alignment, and row actions. |
| P1 | Destructive language | The UI mixes delete, destroy, remove, retire, detach, and purge. Some differences are meaningful, but the consequences are not always visible next to the verb. | Adopt a vocabulary: “destroy” runtime resources, “retire” recoverable configuration, “purge” irreversible retained data, “disconnect” external servers, “detach” volumes. Put consequences in every confirmation. |
| P2 | Dates and units | Dates, times, durations, byte sizes, memory, cost, and IDs are formatted independently across pages. Some timestamps are local strings; others are raw database values. | Add `formatDate`, `formatDateTime`, `formatDuration`, `formatBytes`, `formatMoney`, and `formatResourceId` utilities with explicit timezone behavior. |
| P2 | Empty states | Top-level empty/error/loading states are standardized, but nested cards still vary between centered text, dashed boxes, blank tables, and `EmptyState`. | Add compact and full variants to `PageState`/`EmptyState`, including optional primary action and troubleshooting detail. |
| P2 | Information density | Server metrics, permission matrices, build settings, and operation details use dense bordered boxes with nearly identical emphasis. Scanning is difficult. | Use `SectionHeader`, quieter dividers, grouped definition lists, and one emphasized card per page. Reserve heavy shadow for interactive/elevated surfaces. |
| P2 | Motion | Every route animates on entry and menus/sheets use motion without respecting reduced-motion preferences. | Add a `prefers-reduced-motion` CSS block that disables translation/pulse and shortens non-essential transitions. |
| P2 | Tooltips | `InfoTip` works on hover/focus, but dense help is still hard to discover on touch and tooltips can approach viewport edges. | Use a positioned popover on touch, collision-aware placement, and visible help text for critical operational consequences. |
| P2 | Charts | Sparklines have no axes, time range, value summary, or empty/error distinction. | Build a `MetricCard` with current value, unit, time window, accessible trend summary, and consistent empty/loading states. |
| P2 | Refresh behavior | Polling and refresh actions do not consistently show “last updated”, stale state, or whether refresh is already running. | Add a shared `RefreshButton` and `DataFreshness` label; disable/deduplicate concurrent refreshes. |

## Route-by-route review

| Route/surface | Findings | Proposed solution / status |
| --- | --- | --- |
| Login | Previously duplicated auth framing and primary-button styles. Field errors are toast-only. | Auth framing/buttons migrated. Add persistent inline field errors and caps-lock feedback. |
| Initial setup | Same auth duplication; optional domain guidance competes with account setup. | Migrated to `AuthShell`. Group domain configuration as an optional second section and validate suffix inline. |
| Password reset | Back action was an icon-only boxed button with no text. | Migrated framing/button. Use a labelled text back action and inline passkey errors. |
| Passkey setup/verify | Error text used raw colors and retry/cancel styles differed. | Migrated to `AuthShell`, `Btn`, and `InlineNotice`. Add a clear “waiting for browser” state and recovery guidance. |
| CLI device auth | Eight fixed-width fields overflowed narrow screens and had no individual labels. | Fixed responsive sizing and added accessible labels. Consider a single visually segmented input to simplify paste/autofill. |
| CLI confirmation | Four separate result/pending layouts and duplicated action buttons. | Migrated to shared auth/card/button/state primitives. Continue using explicit red destructive confirmation for destructive actions. |
| Dashboard | Desktop/mobile trees differ; mobile filter had an empty grid column; inline row actions mix menus and buttons. | Fixed grid and desktop shell/header. Extract a shared app/stack list item model and standardize all row actions through one menu/action-sheet API. |
| Environments | Copy popover, expand/collapse editor, attached-app chips, and recovery list all use slightly different row patterns. | Shell/header and recovery section migrated. Add `DisclosureRow`, `Popover`, and `ResourceChip`; keep irreversible purge visually separate from restore. |
| App detail | Mobile and desktop headers/actions are duplicated; tab content has local headings/status colors. | Shell/state migrated. Replace both headers with a responsive `ResourceHeader`; migrate tab sections to `SectionHeader` and shared metric/status cards. |
| App overview | Metrics, DNS, image provenance, placement, server, and volume data have similar bordered emphasis. | Group into “Runtime”, “Delivery”, “Network”, and “Storage”; use definition lists and one consistent `MetricCard`. |
| App logs | Compact but filter/stream state is not prominent. | Add a logs toolbar with connection state, pause/resume, search, download, and line count. |
| Deployments | Table is dense and action placement differs from other history views. | Use `DataTable`, digest truncation/copy, relative + exact timestamps, and a consistent rollback action menu. |
| Scaling | Settings and current state are visually similar despite different mutability/ownership. | Separate manifest-owned desired state from live observed state; use read-only definition rows and explanatory notices. |
| Promotion | Operational consequences and source/target identity need stronger hierarchy. | Use a two-column source → target summary, exact digest chips, and a single primary confirmation action. |
| Stack detail | Operation metadata can become a long text block; actions and status previously shared one crowded line. | Migrated to shared header. Move last operation into a compact linked operation card and use the shared child-operation list. |
| Stack overview | Member table and dependency meaning are not visually explicit. | Add dependency/order indicators and use a mobile-friendly `DataTable`; link status to app details. |
| Stack logs | Member selection and stream status use local controls. | Reuse the logs toolbar and custom select; keep selected member in the route hash for reloadability. |
| Resources | Cost, servers, volumes, deletion audit, and infrastructure tools compete on one long page. | Migrated shell/header/state. Split with tabs or anchored sections: Overview, Servers, Volumes, Recovery, Build capacity. |
| Server detail | Header contains status, pool editing, shell, and refresh in a very small area; metrics lack time/value context. | Migrated header/status. Move pool editing into a settings card/action sheet and adopt `MetricCard`. |
| Volume detail | File browser breadcrumbs/actions are one-off buttons; viewer hierarchy changes between file, directory, and errors. | Migrated shell/state. Add `Breadcrumbs`, a file-list component, content-type/size metadata, and a consistent viewer empty/error state. |
| Operations | User-facing name differed between desktop (“Engine”) and mobile (“Operations”); heartbeat/concurrency were bespoke badges. | Renamed consistently and migrated badges/header/state. Add freshness timestamp and filters by status/kind/resource. |
| Operation detail | Header, status, cancel button, and section titles were all local. Child rows can overflow. | Migrated to shared header/badges/buttons/sections. Make metadata grid responsive and collapse long resource labels. |
| Operation logs | Back/header hierarchy differed from operation detail. | Migrated to shared header. Reuse the logs toolbar and show follow/live state explicitly. |
| Terminal | Fixed `70vh` height ignored mobile navigation; reconnect links are local text buttons. | Fixed responsive height. Add a shared connection-state overlay and `TextButton`; expose terminal keyboard/help controls on touch. |
| Account | Page header now matches the rest, but linked-identity and passkey cards still use local status/action rows. | Migrate to `ConnectionCard` and `CredentialList`; show last-used dates and clearer session-revocation consequences. |
| Admin overview/settings | Monolithic component and inconsistent nested cards/tables. | Header/nav migrated. Split by section and introduce settings/connection/data-table abstractions. |
| User detail | Permission matrix is extremely dense, uses 8–9 px labels, and opens a custom modal. | Header/state/admin badge migrated. Build a searchable permission matrix with group-level actions and the shared dialog. |
| Global nav | Stale version, abbreviated labels, and empty mobile grid slot. Desktop overflow behavior is still a concern at intermediate widths. | Defects fixed. Replace horizontal overflow with a compact “More” menu before labels collide. Source version from an API if shown again. |
| Toasts/confirms | Toasts lacked live semantics; confirm lacked dialog semantics/Escape/scroll locking. | Fixed. Next add optional toast dismissal, focus trap/return, and avoid duplicate confirmation patterns. |
| Tabs/selects/checkboxes | Incomplete keyboard and semantic behavior. | Improved native/ARIA behavior. Add select typeahead and test all controls with keyboard and VoiceOver/NVDA. |

## Suggested implementation order

1. Bundle CSS/fonts locally and replace document zoom with real type tokens.
2. Eliminate duplicated mobile/desktop page trees with `ResourceHeader` and
   responsive list/action primitives.
3. Split Admin and migrate every raw table/button/status to shared components.
4. Consolidate dialogs/popovers, including focus management and placement.
5. Standardize formatting, validation, logs, and metrics.
6. Run visual-regression and accessibility checks at 320, 375, 768, 1024,
   and 1440 px, plus 200% browser zoom and reduced-motion mode.
