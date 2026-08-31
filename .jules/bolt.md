## 2024-05-18 - Replacing JS Hover State with CSS
**Learning:** Using JS-based hover states (e.g., `onMouseOver` triggering a state update) causes frequent and unnecessary component re-renders, especially in long lists.
**Action:** Use CSS-based hover states (e.g., Tailwind CSS `group` and `group-hover`) whenever possible to handle UI changes on hover without triggering React re-renders.
