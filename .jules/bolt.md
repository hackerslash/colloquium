## 2023-10-27 - CSS hover group vs JS mouse enter tracking
**Learning:** JS state-based hovers that update components (like `useState` for tracking `hoveredId` on mouse move events) causes massive re-renders across the entire component list and is a major performance bottleneck for long lists like chat messages.
**Action:** Use CSS named groups (`group/name`, `group-hover/name:opacity-100`) to manage component-level hover state purely in CSS instead of React state and event listeners, significantly reducing JS execution time and React rendering cycles.

## 2024-05-18 - Avoid inline array props breaking child memoization
**Learning:** In React components like `ChatView` where state updates frequently (e.g. typing in a composer updates a local draft state or store), passing inline arrays like `[contactId]` down to large child components like `MessageList` breaks their `React.memo` optimizations. This causes O(N) re-renders (entire message list re-rendering on every keystroke) because the array reference changes on every render.
**Action:** Always wrap arrays and objects passed as props to heavy components in `useMemo` if they are derived from simple primitives or don't change often, and ensure heavy list components like `MessageList` are actually wrapped in `React.memo()`.

## 2024-05-18 - [Optimizing Date Comparisons in React Render Loops]
**Learning:** Using `Date.prototype.toDateString()` for date equality checks in a tight render loop (like mapping over a list of messages) is surprisingly slow because it allocates new string objects each time. In a list of 1000 messages, calculating `!prev || new Date(prev.sentAt).toDateString() !== new Date(message.sentAt).toDateString()` inside the component render cycle takes ~110ms for 100 renders. Switching to manual `.getFullYear()`, `.getMonth()`, and `.getDate()` checks is roughly 2.5x faster (~44ms). Even better, moving this calculation into a `useMemo` block that only recalculates when the messages list changes reduces the overhead to practically zero (<1ms for the same loop) and removes the calculations completely from rapid re-renders like hover states.

**Action:** Avoid allocating strings in tight loops (especially `toDateString()`). Always precalculate and memoize derived row states (like `startsGroup` and `newDay` in message lists) via `useMemo` rather than recalculating them on every render frame.
