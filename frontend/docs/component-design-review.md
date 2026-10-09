# Component design review

This library is a new implementation informed by the Prism v3.2.4 selector atlas. The atlas is evidence for boundaries and visual intent; it does not recover original component source or establish pixel parity.

## Composition

`Button`, `Input`, `Select`, `Badge`, `Card`, and `Spinner` are small native-element primitives. `Field` owns label/help/error relationships, shared by inputs and selects. `Dialog` and `Sheet` share one modal frame while their feature-owned children implement forms, details, and actions. `Tabs` wraps Radix keyboard behavior and accepts content rather than importing features. `EmptyState` accepts any action and decorative icon.

Native element props and refs pass through the native primitives. Feature code owns request state, domain validation, routing, and persistence. Do not add network requests or feature-specific conditions to these components. `Card` deliberately imposes neither padding nor headings so charts, tables, and forms can compose their own regions.

The library uses local CSS variables and semantic classes. `--color-primary` preserves the recovered `#3a3a8c` light-theme brand. `data-theme="dark"` on the document element switches colors, including portaled dialogs. Font stacks name Inter and JetBrains Mono but fall back locally; no external font request is required. The library has no billing, subscription, checkout, payment SDK, or entitlement UI.

## Stable boundaries

| Boundary | Hooks                                                                          | Ownership                     |
| -------- | ------------------------------------------------------------------------------ | ----------------------------- |
| Button   | `.ui-button`, `data-variant`, `data-size`                                      | App primitive                 |
| Field    | `.ui-field`, `data-invalid`, label `for`, `aria-describedby`                   | App primitive                 |
| Status   | `.ui-badge`, `data-tone`                                                       | App primitive                 |
| Modal    | `role=dialog`, `[data-dialog-close]`, optional feature `[data-dialog-confirm]` | Radix behavior, app structure |
| Sheet    | `.ui-sheet`, `data-side=right`                                                 | App modal composition         |
| Tabs     | `role=tablist/tab/tabpanel`, `data-state=active`                               | Radix behavior                |

Prefer accessible role/name in interaction tests. Add feature hooks from the atlas to their actual owners, e.g. `[data-filter-pill-id]` to a filter pill and `[data-tile-id]` to a dashboard tile. Generated field and Radix IDs are relationships, not persistent selectors. The new semantic class names are not claimed to be recovered Prism classes.

## Accessibility review

- Buttons default to `type=button`, preventing accidental form submissions. Feature submit buttons must explicitly use `type=submit`. Icon-only consumers must supply a meaningful `aria-label`.
- Inputs and selects connect visible labels to unique IDs; help and error text connects through `aria-describedby`. Error text has `role=alert`, and invalid controls expose `aria-invalid`. Caller-provided description IDs remain intact.
- The native select retains platform keyboard and mobile behavior. The decorative chevron cannot intercept input or enter the accessibility tree.
- Radix supplies modal focus containment, Escape dismissal, semantic title/description relationships, and background interaction blocking. The frame remembers the focused opener and restores focus on dismissal even when the opener sits outside a Radix trigger. Close controls are named. Modal children remain responsible for labeling all inputs and for validation and submit outcomes.
- Radix Tabs supplies arrow-key navigation, selection state, and tab/panel relationships. Every use should supply a context-specific tab-list label.
- Focus indicators are visible. Status badges contain text so meaning does not depend on color. Spinner provides an accessible loading status. Motion effects stop with `prefers-reduced-motion`.

## Validation and remaining work

The component gallery exercises variants, disabled controls, labeled fields, error state, modal and sheet content, tab content, empty state, and loading. Treat it as an inspectable starting point. Validate representative screens at narrow widths and with keyboard-only navigation, both color themes, zoom, and realistic long content. Authenticated original Logs, initial SQL, datasets and dashboard-list states now have runtime comparisons; see [current parity evidence](prism-parity.md) and [completed validation](validation-review.md). Uncaptured interactions still need comparison. This review is not a full accessibility conformance audit.
