## 2026-09-01 - ARIA Labels for Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (markdown formatters, clear search, categories) that relied only on `title` attributes, which are less reliable than `aria-label` for screen reader users. Added semantic `aria-label` properties to enhance accessibility.
**Action:** Always verify icon-only buttons have `aria-label` attributes when implementing new features or making UX passes.
