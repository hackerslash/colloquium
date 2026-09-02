## 2024-05-14 - Optimize long list hover states with Tailwind CSS
**Learning:** Using JS-based state (e.g. `useState` and `onMouseOver`) to track hover states for list items like chat messages causes significant performance bottlenecks due to cascading re-renders when the mouse moves.
**Action:** Prefer using CSS-based solutions, like Tailwind's `group` and `group-hover`, to handle interactive list hover states natively without triggering React renders.
