## 2024-05-19 - Screen Reader Override
**Learning:** Added aria-label to a button containing dynamic text, which caused the screen reader to only read the aria-label and miss the dynamic text. This violates WCAG 2.5.3 (Label in Name).
**Action:** Ensure that the aria-label includes the visible text content of the button, or rely on the title attribute as a tooltip while letting the screen reader read the visible text.
