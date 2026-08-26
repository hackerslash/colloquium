
## 2024-05-18 - Icon-Only Button Accessibility
**Learning:** Icon-only buttons often rely solely on `title` attributes for tooltips, but screen readers may not consistently announce `title` attributes, leading to accessibility issues.
**Action:** Always ensure that icon-only buttons have explicit `aria-label` attributes to guarantee robust screen reader support, even when a `title` attribute is present.
