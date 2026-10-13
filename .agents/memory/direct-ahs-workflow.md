---
name: Direct AHS workflow boundaries
description: User-required separation from Sasha and future WOM scope for direct AHS AI authorization.
---

Direct AHS workflow: VRS staff click “Approve and Send to VRS AI”; AI obtains AHS's decision, texts the approval or denial code to the IH technician, and the result and notes are saved before the Express ticket is closed.

Keep this workflow completely separate from Sasha and do not change any Sasha code. Prepare notes for a future WOM integration, but do not build the WOM write. Test the full workflow before publishing.

**Why:** The user explicitly requested these boundaries.

**How to apply:** Keep direct-workflow enrollment and callbacks separate from Sasha. Do not silently move SMS responsibility from AI to Express or invent denial codes. Verify the AI service contract and distinguish simulated tests from live end-to-end verification.
