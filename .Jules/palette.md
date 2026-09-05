## 2026-08-30 - Discovered Hidden Functionality
**Learning:** The application had a search feature that was primarily accessible through keyboard shortcuts or hidden entry points. Exposing this via a dedicated icon button significantly improves discoverability and mouse/touch usability.
**Action:** When working on this application, always review available global shortcuts (`useGlobalShortcuts.ts` and `MainShell.tsx` state) to see if there are useful application modes that lack clear visual entry points, and surface them via standard `IconButton` components.
