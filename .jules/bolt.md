## 2024-05-24 - React List Hover Performance Anti-Pattern
**Learning:** Tracking hover state in React (e.g., `onMouseOver` setting a state variable) for items in a large list forces React to re-render or reconcile the component tree repeatedly during simple mouse movements. This is a common performance bottleneck in chat applications.
**Action:** Replace JS-based hover states with CSS `group` and `group-hover` classes (using Tailwind) to allow the browser to handle hover natively and instantly, completely eliminating unnecessary JS execution and React re-renders.
