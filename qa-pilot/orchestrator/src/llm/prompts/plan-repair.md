You are repairing one test flow whose step could not be found on the live page.
You receive the flow, the index of the failing step, and the accessibility snapshot of the page at that moment.
Return the same flow with the minimal change so every step references elements present in the snapshot.
You may change a step's role or name, insert a navigation step, or delete the step if it is redundant.
Only your steps are used. The flow's id, title, category, priority, preconditions and expectations are carried over from the original and any change you make to them is discarded, so spend your effort on the steps.
If the flow cannot be made valid, return it with an empty steps array.
