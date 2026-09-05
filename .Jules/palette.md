## 2026-08-30 - Discovered Hidden Functionality
**Learning:** The application had a search feature that was primarily accessible through keyboard shortcuts or hidden entry points. Exposing this via a dedicated icon button significantly improves discoverability and mouse/touch usability.
**Action:** When working on this application, always review available global shortcuts (`useGlobalShortcuts.ts` and `MainShell.tsx` state) to see if there are useful application modes that lack clear visual entry points, and surface them via standard `IconButton` components.

## 2023-10-27 - SearchModal clear button
**Learning:** Adding a clear button to search inputs significantly improves usability, especially for debounced search where users want to quickly reset the list of results. Also, applying 'focus-within' to a wrapper container and disabling focus on the input itself gives a much cleaner full-width focus state.
**Action:** When creating new search inputs or complex form fields with icons, consider using a wrapper container with 'focus-within' for focus management, and add a quick clear button if the input represents a filter or query.

## 2024-05-19 - Screen Reader Override
**Learning:** Added aria-label to a button containing dynamic text, which caused the screen reader to only read the aria-label and miss the dynamic text. This violates WCAG 2.5.3 (Label in Name).
**Action:** Ensure that the aria-label includes the visible text content of the button, or rely on the title attribute as a tooltip while letting the screen reader read the visible text.
