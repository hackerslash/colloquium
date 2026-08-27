## 2024-05-18 - Replacing React Hover State with CSS

**Learning:** `MessageList` was tracking hover state via React's `onMouseOver`/`onMouseLeave` combined with `useState`. This causes unnecessary re-renders of the entire list whenever the cursor moves between items, a major performance bottleneck for long lists.
**Action:** Always prefer CSS-based hover tracking (`group` and `group-hover:` in Tailwind) over React state for UI interactions that only affect visual styles and do not need to trigger application logic.
